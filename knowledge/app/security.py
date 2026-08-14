from __future__ import annotations

import secrets
from collections.abc import Callable, Coroutine
from typing import Any

from fastapi import Header, HTTPException, status

from .config import Settings


def api_key_dependency(settings: Settings) -> Callable[..., Coroutine[Any, Any, None]]:
    async def require_api_key(
        x_api_key: str | None = Header(default=None, alias="X-API-Key"),
        authorization: str | None = Header(default=None, alias="Authorization"),
    ) -> None:
        if settings.allow_insecure:
            return
        if not settings.api_key:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="KNOWLEDGE_API_KEY is not configured; protected endpoints are fail-closed",
            )
        bearer: str | None = None
        if authorization:
            scheme, _, credentials = authorization.partition(" ")
            if scheme.casefold() == "bearer" and credentials:
                bearer = credentials.strip()
        candidate = x_api_key or bearer or ""
        if not candidate or not secrets.compare_digest(candidate, settings.api_key):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="invalid API key",
                headers={"WWW-Authenticate": "Bearer"},
            )

    return require_api_key
