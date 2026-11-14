#!/usr/bin/env python3
"""Tiny static file server for the game (correct MIME types for ES modules / GLB, range support,
dynamic /api/cars listing so new .glb files dropped into cars/ appear automatically)."""
import http.server
import json
import mimetypes
import os
import socket
import socketserver
import sys
import threading
import webbrowser

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
START_PORT = int(os.environ.get('GAME_PORT', '8765'))

mimetypes.add_type('text/javascript', '.js')
mimetypes.add_type('text/javascript', '.mjs')
mimetypes.add_type('model/gltf-binary', '.glb')
mimetypes.add_type('application/json', '.json')
mimetypes.add_type('image/svg+xml', '.svg')
mimetypes.add_type('audio/mpeg', '.mp3')
mimetypes.add_type('audio/ogg', '.ogg')


def list_cars():
    cars_dir = os.path.join(ROOT, 'cars')
    out = []
    if os.path.isdir(cars_dir):
        for f in sorted(os.listdir(cars_dir)):
            if f.lower().endswith('.glb'):
                out.append(f)
    return out


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache')
        self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
        super().end_headers()

    def do_GET(self):
        if self.path.split('?')[0] == '/api/cars':
            body = json.dumps(list_cars()).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        return super().do_GET()

    def log_message(self, fmt, *args):
        if os.environ.get('GAME_VERBOSE'):
            super().log_message(fmt, *args)


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main():
    port = START_PORT
    httpd = None
    for p in range(START_PORT, START_PORT + 30):
        try:
            httpd = Server(('127.0.0.1', p), Handler)
            port = p
            break
        except OSError:
            continue
    if httpd is None:
        print('Could not find a free port.')
        sys.exit(1)
    url = f'http://localhost:{port}/'
    print('=' * 60)
    print('  ASPHALT FOREST - racing game server running')
    print(f'  Open: {url}')
    print('  (Close this window to stop the game server)')
    print('=' * 60)
    if '--no-browser' not in sys.argv:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
