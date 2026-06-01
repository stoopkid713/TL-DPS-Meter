"""Single-instance / port-in-use handling (main.py).

A second launch can't bind the WS port (Errno 10048 on Windows). It must NOT crash
with a traceback — it should be recognized as "already running" and exit cleanly.
Regression for the 2-PC live test where a double-launch crashed the backend loop.
"""
import errno
import socket

import pytest

import main


def test_classifier_recognizes_address_in_use():
    e_posix = OSError(); e_posix.errno = errno.EADDRINUSE
    assert main._is_address_in_use(e_posix)

    e_win = OSError(); e_win.winerror = 10048  # WSAEADDRINUSE
    assert main._is_address_in_use(e_win)


def test_classifier_ignores_other_errors():
    e_other = OSError(); e_other.errno = errno.ECONNREFUSED
    assert not main._is_address_in_use(e_other)
    assert not main._is_address_in_use(ValueError("not an OSError"))
    assert not main._is_address_in_use(OSError("no errno set"))


def test_backend_start_raises_recognized_error_when_port_busy(tmp_path):
    """Occupy the port, then Backend.start() must raise an error the classifier flags
    (so main() can turn it into a clean 'already running' instead of crashing)."""
    port = 8799  # not 8765 — never clobber a real running instance
    occupier = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        occupier.bind(("127.0.0.1", port))
        occupier.listen(1)
    except OSError:
        pytest.skip("could not occupy test port 8799")
    try:
        backend = main.Backend(str(tmp_path), host=main.HOST, port=port, ready_timeout=5.0)
        with pytest.raises(OSError) as ei:
            backend.start()
        assert main._is_address_in_use(ei.value), f"unexpected error: {ei.value!r}"
    finally:
        try:
            backend.stop()
        except Exception:
            pass
        occupier.close()
