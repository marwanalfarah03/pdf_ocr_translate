import os

from backend.app import app


if __name__ == "__main__":
    debug_enabled = os.environ.get("FLASK_DEBUG", "0") == "1"
    port = int(os.environ.get("PORT", "8016"))
    app.run(
        host="0.0.0.0",
        port=port,
        debug=debug_enabled,
        use_reloader=debug_enabled,
        threaded=True,
    )
