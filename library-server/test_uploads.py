"""Provider-free upload tests. Optional staged adapter integration via --adapter-dir."""
import base64
import asyncio
from concurrent.futures import ThreadPoolExecutor
import contextlib
from email.message import Message
import hashlib
from http.client import HTTPConnection
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib
import io
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import threading
import types
import unittest
from urllib.parse import quote
import zipfile

import uploads

ADAPTER = None
if '--adapter-dir' in sys.argv:
    index = sys.argv.index('--adapter-dir')
    directory = sys.argv[index + 1]
    del sys.argv[index:index + 2]
    sys.path.insert(0, directory)
    ADAPTER = importlib.import_module('library_server')


class CatalogStub:
    @staticmethod
    def clean(text, limit=500):
        return ' '.join(text.split())[:limit]

    @staticmethod
    def now():
        return '2026-10-05T00:00:00Z'

    @staticmethod
    def read_metadata(path, name):
        return dict(title=Path(name).stem, authors=[], identifiers=[])

    @staticmethod
    def storage_path(base, metadata, digest):
        fmt = metadata.get('format', 'epub')
        return f'{base}/{fmt}/{digest[:2]}/{digest}.{fmt}'


class ProviderStub:
    def __init__(self):
        self.files = {}
        self.calls = 0
        self.fail = False

    def ensure_dir(self, directory):
        return {path: item for path, item in self.files.items() if str(Path(path).parent) == directory}

    def upload(self, local, remote):
        if self.fail:
            raise RuntimeError('secret-token-must-not-be-returned')
        self.calls += 1
        item = dict(path=remote, fs_id=self.calls, size=local.stat().st_size)
        self.files[remote] = item
        return item

    def metadata(self, fsid):
        return next(item for item in self.files.values() if str(item['fs_id']) == str(fsid))


def make_epub():
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, 'w') as archive:
        archive.writestr('mimetype', 'application/epub+zip')
        archive.writestr('META-INF/container.xml', '<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>')
        archive.writestr('book.opf', '<package><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Original title</dc:title></metadata></package>')
    return stream.getvalue()


def headers(name='书.pdf', mime='application/pdf', length=10):
    result = Message()
    for key, value in {'X-File-Name': quote(name), 'Content-Type': mime, 'Content-Length': str(length)}.items():
        result[key] = value
    return result


class UploadTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.private = Path(self.temp.name)
        self.provider = ProviderStub()
        self.catalog = ADAPTER.catalog if ADAPTER else CatalogStub
        with sqlite3.connect(self.private / 'progress.sqlite3') as db:
            db.executescript('''CREATE TABLE catalog (
                book_id TEXT PRIMARY KEY,title TEXT,authors TEXT,metadata TEXT,search_text TEXT,
                fs_id TEXT,remote_path TEXT UNIQUE,size INTEGER,created_at TEXT,updated_at TEXT);
                CREATE TABLE books(message_id INTEGER PRIMARY KEY,document_id TEXT,name TEXT,
                size INTEGER,state TEXT,remote_path TEXT,sha256 TEXT,error TEXT);
                CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT);''')
        def verify(item, size, path):
            if item['size'] != size or item['path'] != path:
                raise RuntimeError('invalid remote response')
        self.sync = types.SimpleNamespace(read_config=lambda: {'remote_dir': '/apps/test/books'},
                                         Baidu=lambda config: self.provider, verify_remote=verify)
        self.backend = uploads.Backend(self.private, self.catalog, self.sync)

    def tearDown(self):
        self.temp.cleanup()

    def ingest(self, data=b'%PDF-1.7\nbook\n%%EOF', name='book.pdf', title='', author=''):
        fmt = Path(name).suffix[1:]
        return self.backend.ingest(io.BytesIO(data), (name, fmt, len(data), title, author))

    def test_formats_metadata_and_repeat(self):
        books = [('epub', make_epub()), ('pdf', b'%PDF-1.7\nbook\n%%EOF')]
        books += [(fmt, b'\x00' * 60 + b'BOOKMOBI' + b'\x00' * 8 + b'\x00\x01' + (86).to_bytes(4, 'big') + b'\x00' * 4 + b'\x00' * 16 + b'MOBI' + fmt.encode())
                  for fmt in ('azw', 'azw3', 'mobi')]
        for fmt, data in books:
            with self.subTest(fmt=fmt):
                first = self.ingest(data, '收藏.' + fmt, '自定义书名', '作者')
                duplicate = self.ingest(data, '另一个名字.' + fmt, '不覆盖旧标题')
                self.assertEqual(first['format'], fmt)
                self.assertEqual(first['title'], '自定义书名')
                self.assertFalse(first['duplicate'])
                self.assertTrue(duplicate['duplicate'])
                self.assertEqual(duplicate['bookId'], hashlib.sha256(data).hexdigest())
                self.assertEqual(duplicate['title'], '自定义书名')
        self.assertEqual(self.provider.calls, 5)
        self.assertFalse(list(self.private.glob('upload-*/*book*')))

    def test_simultaneous_duplicate_uploads(self):
        with ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(lambda _: self.ingest(), range(8)))
        self.assertEqual(self.provider.calls, 1)
        self.assertEqual(sum(not result['duplicate'] for result in results), 1)

    def test_partial_invalid_and_provider_failure_cleanup(self):
        corrupted_epub = make_epub().replace(b'Original title', b'Corrupt! title')
        for data, fmt in [(b'bad', 'pdf'), (b'%PDF-1.7\ntruncated', 'pdf'),
                          (b'bad', 'epub'), (corrupted_epub, 'epub'), (b'bad', 'azw'),
                          (b'\x00' * 60 + b'BOOKMOBI' + b'\x00' * 20, 'azw3')]:
            with self.assertRaises(uploads.UploadError):
                self.backend.ingest(io.BytesIO(data), ('bad.' + fmt, fmt, len(data), '', ''))
        with self.assertRaises(uploads.UploadError):
            self.backend.ingest(io.BytesIO(b'%PDF-'), ('bad.pdf', 'pdf', 80, '', ''))
        self.provider.fail = True
        with self.assertRaises(RuntimeError):
            self.ingest()
        self.assertFalse([path for path in self.private.glob('upload-*') if path.name != 'upload-locks'])
        with sqlite3.connect(self.private / 'progress.sqlite3') as db:
            self.assertEqual(db.execute('SELECT count(*) FROM catalog').fetchone()[0], 0)

    def test_header_rejections(self):
        cases = [(headers(length=uploads.MAX_FILE_BYTES + 1), 413),
                 (headers(name='../book.pdf'), 400), (headers(name='book.exe'), 415),
                 (headers(mime='text/html'), 415), (headers(length=0), 400)]
        malformed = headers()
        malformed.replace_header('X-File-Name', '%ZZ.pdf')
        cases.append((malformed, 400))
        duplicate = headers()
        duplicate['Content-Length'] = '10'
        cases.append((duplicate, 411))
        chunked = headers()
        chunked['Transfer-Encoding'] = 'chunked'
        cases.append((chunked, 400))
        for value, status in cases:
            with self.subTest(status=status), self.assertRaises(uploads.UploadError) as caught:
                uploads.request_details(value)
            self.assertEqual(caught.exception.status, status)
        self.assertEqual(uploads.request_details(headers())[0], '书.pdf')
        for mime in ('application/x-mobi8-ebook', 'application/vnd.amazon.mobi8-ebook'):
            self.assertEqual(uploads.request_details(headers(name='book.azw3', mime=mime))[1], 'azw3')
        oversized_number = headers()
        oversized_number.replace_header('Content-Length', '9' * 5000)
        with self.assertRaises(uploads.UploadError) as caught:
            uploads.request_details(oversized_number)
        self.assertEqual(caught.exception.status, 413)

    @contextlib.contextmanager
    def serving(self):
        class Handler(uploads.UploadHandlerMixin, BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def send_data(self, data, status=200):
                self.send_response(status)
                self.send_header('Content-Length', str(len(data)))
                self.end_headers()
                self.wfile.write(data)
        handler = ADAPTER.Handler if ADAPTER else Handler
        if ADAPTER:
            previous_private = ADAPTER.sync.PRIVATE
            ADAPTER.sync.PRIVATE = self.private
        server = ThreadingHTTPServer(('127.0.0.1', 0), handler)
        server.credentials = {'username': 'test', 'password': 'test'}
        server.upload_backend = self.backend
        server.cors_origins = {'https://reader.example'}
        server.download_slots = threading.BoundedSemaphore(2)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            yield server
        finally:
            server.shutdown()
            server.server_close()
            thread.join()
            if ADAPTER:
                ADAPTER.sync.PRIVATE = previous_private

    def request(self, server, method='POST', path='/api/upload', data=b'%PDF-1.7\nbook\n%%EOF', auth=True, extra=None):
        request_headers = dict(headers(length=len(data)).items())
        if auth:
            request_headers['Authorization'] = 'Basic ' + base64.b64encode(b'test:test').decode()
        request_headers.update(extra or {})
        connection = HTTPConnection(*server.server_address, timeout=5)
        try:
            connection.request(method, path, body=data, headers=request_headers)
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            connection.close()

    def test_http_auth_duplicate_busy_and_sanitized_error(self):
        with self.serving() as server:
            self.assertEqual(self.request(server, auth=False)[0], 401)
            self.assertEqual(self.request(server, path='/other')[0], 404)
            self.assertEqual(self.request(server)[0], 201)
            status, _, body = self.request(server)
            self.assertEqual(status, 200)
            self.assertTrue(json.loads(body)['duplicate'])
            self.backend.slots.acquire()
            self.backend.slots.acquire()
            try:
                self.assertEqual(self.request(server)[0], 503)
            finally:
                self.backend.slots.release()
                self.backend.slots.release()
            self.provider.fail = True
            status, _, body = self.request(server, data=b'%PDF-1.7\nother\n%%EOF')
            self.assertEqual(status, 502)
            self.assertNotIn(b'secret-token', body)

    @unittest.skipUnless(ADAPTER, 'requires staged adapter')
    def test_opds_discovery_catalog_and_real_download_format(self):
        with self.serving() as server:
            self.assertEqual(self.request(server, method='GET', path='/api/library', auth=False)[0], 401)
            _, _, body = self.request(server, method='GET', path='/api/library')
            self.assertEqual(json.loads(body), uploads.CAPABILITIES)
            status, response_headers, _ = self.request(server, method='OPTIONS', extra={'Origin': 'https://reader.example'})
            self.assertEqual(status, 204)
            self.assertIn('POST', response_headers['Access-Control-Allow-Methods'])
            self.assertIn('X-Book-Title', response_headers['Access-Control-Allow-Headers'])
            _, _, body = self.request(server)
            book = json.loads(body)
            _, _, body = self.request(server, method='GET', path='/opds')
            self.assertIn(b'https://lightread.app/rel/library', body)
            self.assertIn(b'https://lightread.app/rel/upload', body)
            self.assertIn(b'application/pdf', body)
            self.assertIn((book['bookId'] + '.pdf').encode(), body)
            _, _, body = self.request(server, method='GET', path='/api/books')
            self.assertEqual(json.loads(body)['books'][0]['format'], 'pdf')
            self.assertEqual(self.request(server, method='GET', path='/download/' + book['bookId'] + '.epub')[0], 404)
            original_fetch = ADAPTER.fetch_book
            ADAPTER.fetch_book = lambda item, output: output.write_bytes(b'%PDF-1.7\nbook\n%%EOF')
            try:
                status, response_headers, body = self.request(server, method='GET', path='/download/' + book['bookId'] + '.pdf')
                self.assertEqual(status, 200)
                self.assertEqual(response_headers['Content-Type'], 'application/pdf')
                self.assertIn('.pdf', response_headers['Content-Disposition'])
                self.assertEqual(body, b'%PDF-1.7\nbook\n%%EOF')
            finally:
                ADAPTER.fetch_book = original_fetch

    @unittest.skipUnless(ADAPTER, 'requires staged adapter')
    def test_historical_epub_default_and_collector_record(self):
        payload = make_epub()
        result = self.ingest(payload, 'history.epub')
        with contextlib.closing(sqlite3.connect(self.private / 'progress.sqlite3')) as db:
            db.row_factory = sqlite3.Row
            row = db.execute('SELECT * FROM catalog').fetchone()
            metadata = json.loads(row['metadata'])
            metadata.pop('format')
            db.execute('UPDATE catalog SET metadata=?', (json.dumps(metadata),))
            db.execute("INSERT INTO books(message_id,document_id,name,size,state) VALUES(1,'doc','history.epub',?,'pending')", (len(payload),))
            db.commit()
            row = db.execute('SELECT * FROM catalog').fetchone()
            self.assertEqual(ADAPTER.catalog.public_book(db, row)['format'], 'epub')
            source = db.execute('SELECT * FROM books').fetchone()
            ADAPTER.catalog.record(db, result['bookId'], metadata,
                                   {'fs_id': row['fs_id'], 'path': row['remote_path']}, source)
            book = ADAPTER.catalog.public_book(db, db.execute('SELECT * FROM catalog').fetchone())
            self.assertEqual(book['sources'][0]['message_id'], '1')
            self.assertEqual(db.execute('SELECT count(*) FROM catalog').fetchone()[0], 1)

    @unittest.skipUnless(ADAPTER, 'requires staged adapter')
    def test_upload_and_collection_share_digest_lock(self):
        payload = make_epub()
        cache = self.private / 'cache'
        cache.mkdir()
        (cache / '1.epub').write_bytes(payload)
        with sqlite3.connect(self.private / 'progress.sqlite3') as db:
            db.execute("INSERT INTO books(message_id,document_id,name,size,state) VALUES(1,'doc','history.epub',?,'pending')", (len(payload),))
        previous_private = ADAPTER.sync.PRIVATE
        ADAPTER.sync.PRIVATE = self.private
        def collect():
            with contextlib.closing(sqlite3.connect(self.private / 'progress.sqlite3', timeout=30)) as db:
                db.row_factory = sqlite3.Row
                row = db.execute('SELECT * FROM books').fetchone()
                asyncio.run(ADAPTER.sync.transfer(None, None, self.provider,
                                                  self.sync.read_config(), db, row, {}))
        try:
            with ThreadPoolExecutor(max_workers=2) as pool:
                futures = [pool.submit(self.ingest, payload, 'manual.epub'), pool.submit(collect)]
                for future in futures:
                    future.result(timeout=10)
            self.assertEqual(self.provider.calls, 1)
            with sqlite3.connect(self.private / 'progress.sqlite3') as db:
                self.assertEqual(db.execute('SELECT count(*) FROM catalog').fetchone()[0], 1)
                self.assertEqual(db.execute('SELECT state FROM books').fetchone()[0], 'done')
        finally:
            ADAPTER.sync.PRIVATE = previous_private


if __name__ == '__main__':
    unittest.main()
