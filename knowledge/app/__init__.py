"""Hermes local knowledge sidecar."""

from typing import Any


def create_app(*args: Any, **kwargs: Any) -> Any:
    """Load the FastAPI factory lazily so utility imports do not load a model."""
    from .main import create_app as factory

    return factory(*args, **kwargs)


__all__ = ["create_app"]
