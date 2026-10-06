"""Authenticated, bounded book uploads for the private LightRead OPDS adapter.

No provider credentials or collection logic live in this module.
"""
import base64
import contextlib
import fcntl
import hashlib
import json
from pathlib import Path
import re
import secrets
import shutil
import socket
import sqlite3
import tempfile
import threading
from urllib.parse import unquote, urlparse
import zipfile

MAX_FILE_BYTES = 90 * 1024 * 1024
FORMATS = {
    'epub': 'application/epub+zip',
    'pdf': 'application/pdf',
    'azw': 'application/vnd.amazon.ebook',
    'azw3': 'application/x-mobi8-ebook',
    'mobi': 'application/x-mobipocket-ebook',
}
CAPABILITIES = dict(version=1, uploadUrl='/api/upload', formats=list(FORMATS),
                    maxFileBytes=MAX_FILE_BYTES)


class UploadError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


def decoded_header(headers, name, required=False):
    raw = headers.get(name, '')
    if len(raw) > 4096 or re.search(r'%(?![0-9a-fA-F]{2})', raw):
        raise UploadError(400, 'invalid metadata header')
    try:
        value = unquote(raw, encoding='utf-8', errors='strict').strip()
    except UnicodeError:
        raise UploadError(400, 'invalid metadata encoding') from None
    if any(ord(c) < 32 or ord(c) == 127 for c in value) or (required and not value):
        raise UploadError(400, 'missing or invalid metadata')
    return value


def request_details(headers):
    if headers.get('Transfer-Encoding'):
        raise UploadError(400, 'chunked uploads are not supported')
    lengths = headers.get_all('Content-Length', [])
    if len(lengths) != 1 or not re.fullmatch(r'[0-9]+', lengths[0]):
        raise UploadError(411, 'one Content-Length is required')
    if len(lengths[0]) > 12:
        raise UploadError(413, 'book exceeds 90 MiB')
    length = int(lengths[0])
    if length > MAX_FILE_BYTES:
        raise UploadError(413, 'book exceeds 90 MiB')
    if length < 1:
        raise UploadError(400, 'empty book')
    name = decoded_header(headers, 'X-File-Name', True)
    if '/' in name or '\\' in name or len(name.encode('utf-8')) > 512:
        raise UploadError(400, 'invalid file name')
    fmt = Path(name).suffix.lower().lstrip('.')
    if fmt not in FORMATS:
        raise UploadError(415, 'unsupported book format')
    mime = headers.get('Content-Type', '').split(';')[0].strip().lower()
    allowed = {FORMATS[fmt]}
    if fmt in ('azw', 'azw3', 'mobi'):
        allowed.update(FORMATS[k] for k in ('azw', 'azw3', 'mobi'))
        allowed.add('application/vnd.amazon.mobi8-ebook')
    if mime not in allowed:
        raise UploadError(415, 'Content-Type does not match book format')
    return name, fmt, length, decoded_header(headers, 'X-Book-Title'), decoded_header(headers, 'X-Book-Author')


def validate_file(path, fmt):
    with path.open('rb') as stream:
        head = stream.read(1024)
    if fmt == 'epub':
        try:
            with zipfile.ZipFile(path) as archive:
                entries = archive.infolist()
                if len(entries) > 10000 or sum(item.file_size for item in entries) > 512 * 1024 * 1024:
                    raise UploadError(415, 'EPUB expanded size or entry count exceeds validation limits')
                entry = archive.getinfo('mimetype')
                if entry.file_size > 64 or archive.read(entry).strip() != b'application/epub+zip':
                    raise ValueError()
                if 'META-INF/container.xml' not in archive.namelist():
                    raise ValueError()
                if archive.testzip() is not None:
                    raise ValueError()
        except (zipfile.BadZipFile, KeyError, ValueError, RuntimeError):
            raise UploadError(415, 'invalid EPUB container') from None
    elif fmt == 'pdf':
        if not head.startswith(b'%PDF-'):
            raise UploadError(415, 'invalid PDF header')
        with path.open('rb') as stream:
            stream.seek(max(0, path.stat().st_size - 4096))
            if b'%%EOF' not in stream.read():
                raise UploadError(415, 'incomplete PDF container')
    else:
        if len(head) < 78 or head[60:68] != b'BOOKMOBI':
            raise UploadError(415, 'invalid Kindle/Mobipocket container')
        records = int.from_bytes(head[76:78], 'big')
        table_end = 78 + records * 8
        size = path.stat().st_size
        if not records or table_end > size:
            raise UploadError(415, 'incomplete Kindle record table')
        with path.open('rb') as stream:
            stream.seek(78)
            table = stream.read(records * 8)
            offsets = [int.from_bytes(table[index:index + 4], 'big') for index in range(0, len(table), 8)]
            if offsets[0] < table_end or any(start >= end for start, end in zip(offsets, offsets[1:] + [size])):
                raise UploadError(415, 'invalid Kindle record offsets')
            stream.seek(offsets[0] + 16)
            if stream.read(4) != b'MOBI':
                raise UploadError(415, 'invalid Kindle content header')


@contextlib.contextmanager
def digest_lock(private, digest):
    """Cross-process lock shared with the collection worker (256 bounded files)."""
    if not re.fullmatch('[0-9a-f]{64}', digest):
        raise ValueError('invalid digest')
    directory = Path(private) / 'upload-locks'
    directory.mkdir(mode=0o700, exist_ok=True)
    with (directory / (digest[:2] + '.lock')).open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)


class Backend:
    def __init__(self, private, catalog, sync):
        self.private, self.catalog, self.sync = Path(private), catalog, sync
        self.slots = threading.BoundedSemaphore(2)

    def ingest(self, stream, details):
        name, fmt, length, title, author = details
        if shutil.disk_usage(self.private).free < length + 1024 ** 3:
            raise UploadError(507, 'insufficient temporary disk space')
        with tempfile.TemporaryDirectory(prefix='upload-', dir=self.private) as temp:
            path = Path(temp) / ('book.' + fmt)
            digest = hashlib.sha256()
            remaining = length
            with path.open('wb') as output:
                while remaining:
                    chunk = stream.read(min(1024 * 1024, remaining))
                    if not chunk:
                        raise UploadError(400, 'incomplete upload')
                    output.write(chunk)
                    digest.update(chunk)
                    remaining -= len(chunk)
            validate_file(path, fmt)
            ident = digest.hexdigest()
            metadata = self.catalog.read_metadata(path, name) if fmt == 'epub' else {
                'title': self.catalog.clean(Path(name).stem), 'authors': [], 'identifiers': [],
                'subjects': [], 'language': '', 'publisher': '', 'published': '',
                'description': '', 'metadata_source': 'filename', 'metadata_warning': '',
            }
            if title:
                metadata['title'] = self.catalog.clean(title)
            if author:
                metadata['authors'] = [self.catalog.clean(author)]
            metadata.update(format=fmt, original_name=name)
            with digest_lock(self.private, ident), contextlib.closing(sqlite3.connect(
                    self.private / 'progress.sqlite3', timeout=30)) as db:
                db.row_factory = sqlite3.Row
                existing = db.execute('SELECT * FROM catalog WHERE book_id=?', (ident,)).fetchone()
                if existing:
                    return self.result(existing, True)
                config = self.sync.read_config()
                provider = self.sync.Baidu(config)
                remote = self.catalog.storage_path(config['remote_dir'], metadata, ident)
                parent = str(Path(remote).parent)
                provider.ensure_dir(config['remote_dir'] + '/' + fmt)
                remote_files = provider.ensure_dir(parent)
                # Retry after a successful remote upload but failed DB commit reuses the same path.
                item = remote_files.get(remote) or provider.upload(path, remote)
                self.sync.verify_remote(item, length, remote)
                stamp = self.catalog.now()
                search = self.catalog.clean(' '.join([metadata['title'], *metadata['authors'], name]), 4000).casefold()
                with db:
                    db.execute('''INSERT INTO catalog
                        (book_id,title,authors,metadata,search_text,fs_id,remote_path,size,created_at,updated_at)
                        VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(book_id) DO NOTHING''',
                        (ident, metadata['title'], json.dumps(metadata['authors'], ensure_ascii=False),
                         json.dumps(metadata, ensure_ascii=False), search, str(item['fs_id']),
                         item['path'], length, stamp, stamp))
                return dict(bookId=ident, title=metadata['title'], format=fmt, duplicate=False)

    @staticmethod
    def result(row, duplicate):
        return dict(bookId=row['book_id'], title=row['title'],
                    format=json.loads(row['metadata']).get('format', 'epub'), duplicate=duplicate)


class UploadHandlerMixin:
    def authenticated(self):
        expected = 'Basic ' + base64.b64encode(
            f'{self.server.credentials["username"]}:{self.server.credentials["password"]}'.encode()).decode()
        return secrets.compare_digest(self.headers.get('Authorization', '').encode(), expected.encode())

    def do_POST(self):
        # Always close: rejected bodies must never be parsed as a subsequent request.
        self.close_connection = True
        if not self.authenticated():
            self.send_data(b'{"error":"authentication required"}', status=401)
            return
        if urlparse(self.path).path != '/api/upload':
            self.send_data(b'{"error":"not found"}', status=404)
            return
        backend = self.server.upload_backend
        acquired = False
        previous_timeout = self.connection.gettimeout()
        try:
            details = request_details(self.headers)
            acquired = backend.slots.acquire(blocking=False)
            if not acquired:
                raise UploadError(503, 'upload busy, retry later')
            self.connection.settimeout(120)
            result = backend.ingest(self.rfile, details)
            self.send_data(json.dumps(result, ensure_ascii=False).encode(),
                           status=200 if result['duplicate'] else 201)
        except UploadError as error:
            self.send_data(json.dumps({'error': str(error)}).encode(), status=error.status)
        except (socket.timeout, TimeoutError):
            self.send_data(b'{"error":"upload timeout"}', status=408)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception:
            # Provider exception strings can contain signed URLs or credentials.
            self.send_data(b'{"error":"upload failed, retry later"}', status=502)
        finally:
            self.connection.settimeout(previous_timeout)
            if acquired:
                backend.slots.release()
