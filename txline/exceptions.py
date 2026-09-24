"""Shared exception types."""


class TxLineStreamError(RuntimeError):
    """Raised when a stream request is rejected before any SSE data arrives
    (e.g. no ticket held for the requested fixture, auth rejected) — surfaces
    the server's actual error body instead of a confusing SSEError about the
    Content-Type not being text/event-stream."""
