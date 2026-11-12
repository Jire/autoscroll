# SPDX-License-Identifier: GPL-2.0-or-later
# Qt scroll test client (PyQt6, or PyQt5 with QT_API=5): prints positions as JSON lines.
import json, os, sys, time
if os.environ.get('QT_API') == '5':
    from PyQt5.QtWidgets import QApplication, QMainWindow, QScrollArea, QWidget
else:
    from PyQt6.QtWidgets import QApplication, QMainWindow, QScrollArea, QWidget
start = time.monotonic()
def emit(**f):
    print(json.dumps({'t': round((time.monotonic() - start) * 1000), **f}), flush=True)
app = QApplication(sys.argv[:1])
win = QMainWindow()
win.setWindowTitle(sys.argv[1] if len(sys.argv) > 1 else 'Qt test')
area = QScrollArea()
inner = QWidget()
inner.setMinimumSize(4000, 40000)
area.setWidget(inner)
win.setCentralWidget(area)
win.resize(900, 700)
area.verticalScrollBar().valueChanged.connect(lambda v: emit(ev='position', x=0, y=v))
win.show()
emit(ev='ready')
app.exec()
