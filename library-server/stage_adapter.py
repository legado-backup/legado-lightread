#!/usr/bin/env python3
"""Prepare an existing private server in a NEW staging directory, never deploy it."""
import argparse
from pathlib import Path
import shutil


def replace_once(text, old, new):
    if text.count(old) != 1:
        raise ValueError('Private adapter differs from expected version; review manually: ' + old[:60])
    return text.replace(old, new, 1)


def adapt(source, output):
    source, output = Path(source).resolve(), Path(output).resolve()
    if source == output or output.exists():
        raise ValueError('Output must be a new directory distinct from the deployed server')
    server = (source / 'library_server.py').read_text()
    catalog = (source / 'catalog.py').read_text()
    sync = (source / 'sync.py').read_text()
    server = replace_once(server, 'import catalog\n', 'import catalog\nimport uploads\n')
    server = replace_once(server, "book['description'] or book['publisher'] or 'EPUB'",
                          "book['description'] or book['publisher'] or book['format'].upper()")
    server = replace_once(server, '再点击 EPUB 下载到轻阅。', '再下载到轻阅；也可通过「添加书籍」上传 EPUB、PDF、AZW、AZW3、MOBI。')
    server = replace_once(server, 'class Handler(BaseHTTPRequestHandler):',
                          'class Handler(uploads.UploadHandlerMixin, BaseHTTPRequestHandler):')
    server = replace_once(server, "'GET, OPTIONS'", "'GET, POST, OPTIONS'")
    server = replace_once(server, "'Authorization, Accept'",
                          "'Authorization, Accept, Content-Type, X-File-Name, X-Book-Title, X-Book-Author'")
    server = replace_once(server, "    for book in books:\n", """    add(feed, 'link', rel='https://lightread.app/rel/upload', href='/api/upload', type='application/json')
    add(feed, 'link', rel='https://lightread.app/rel/library', href='/api/library', type='application/json')
    for book in books:
""")
    server = replace_once(server,
                          "href='/download/' + book['book_id'] + '.epub', type='application/epub+zip')",
                          "href='/download/' + book['book_id'] + '.' + book['format'], type=uploads.FORMATS[book['format']])")
    server = replace_once(server, "            with contextlib.closing(read_db()) as db:\n", """            if path.path == '/api/library':
                self.send_data(json.dumps(uploads.CAPABILITIES).encode())
                return
            with contextlib.closing(read_db()) as db:
""")
    server = replace_once(server,
                          "ident = path.path.removeprefix('/download/').removesuffix('.epub')",
                          "name = path.path.removeprefix('/download/')\n                    ident, _, extension = name.rpartition('.')")
    server = replace_once(server, "                    book = catalog.public_book(db, row)\n", """                    book = catalog.public_book(db, row)
                    if extension != book['format']:
                        self.send_data(b'{"error":"not found"}', status=404)
                        return
""")
    server = replace_once(server, "file = Path(temp) / 'book.epub'", "file = Path(temp) / ('book.' + book['format'])")
    server = replace_once(server, "self.send_header('Content-Type', 'application/epub+zip')",
                          "self.send_header('Content-Type', uploads.FORMATS[book['format']])")
    server = replace_once(server, "quote(book['title'] + '.epub')", "quote(book['title'] + '.' + book['format'])")
    server = replace_once(server, '    server.download_slots = threading.BoundedSemaphore(2)\n',
                          '    server.download_slots = threading.BoundedSemaphore(2)\n'
                          '    server.upload_backend = uploads.Backend(sync.PRIVATE, catalog, sync)\n')
    catalog = replace_once(catalog,
                           "return f'{base}/epub/{digest[:2]}/{title} - {author} [{digest[:16]}].epub'",
                           "fmt = metadata.get('format', 'epub')\n    return f'{base}/{fmt}/{digest[:2]}/{title} - {author} [{digest[:16]}].{fmt}'")
    catalog = replace_once(catalog, "format='epub', created_at=", "format=json.loads(row['metadata']).get('format', 'epub'), created_at=")
    # Share only the transfer's post-hash critical section, not its network download,
    # with uploads. This preserves existing queue and collection implementation.
    sync = replace_once(sync, 'import catalog\n', 'import catalog\nimport uploads\n')
    sync = replace_once(sync, "sqlite3.connect(PRIVATE / 'progress.sqlite3')",
                        "sqlite3.connect(PRIVATE / 'progress.sqlite3', timeout=30)")
    start_marker = "    metadata = catalog.read_metadata(local, row['name'])\n"
    end_marker = "    local.unlink()\n"
    if sync.count(start_marker) != 1 or sync.count(end_marker) != 1:
        raise ValueError('Transfer adapter differs from expected version')
    start, end = sync.index(start_marker), sync.index(end_marker)
    section = sync[start:end]
    sync = sync[:start] + "    with uploads.digest_lock(PRIVATE, digest):\n" + ''.join(
        '    ' + line if line.strip() else line for line in section.splitlines(keepends=True)) + sync[end:]
    output.mkdir(mode=0o700, parents=True)
    for name, content in [('library_server.py', server), ('catalog.py', catalog), ('sync.py', sync)]:
        path = output / name
        path.write_text(content)
        path.chmod(0o600)
    shutil.copyfile(Path(__file__).with_name('uploads.py'), output / 'uploads.py')
    (output / 'uploads.py').chmod(0o600)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', required=True)
    parser.add_argument('--output', required=True)
    arguments = parser.parse_args()
    adapt(arguments.source, arguments.output)
