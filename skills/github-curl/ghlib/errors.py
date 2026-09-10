"""Typed failures, each carrying the process exit code it maps to."""


class GhError(Exception):
    code = 3

    def __init__(self, message):
        super().__init__(message)
        self.message = message


class UsageError(GhError):
    code = 1


class AuthError(GhError):
    code = 2


class ApiError(GhError):
    code = 3


class NotFound(GhError):
    code = 4


class RateLimited(GhError):
    code = 5
