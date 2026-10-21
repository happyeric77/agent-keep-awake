# Lessons

- When the user specifies opencode-agy, delegate through its tool rather than switching to direct CLI execution; report tool failures before changing execution channels.

- When integrating external runtimes, verify authoritative OpenAPI schemas and runtime sources instead of assuming legacy or inventing event shapes.
- When a delegated CLI reports an authentication error, verify a fresh request and its launch context before concluding the user is logged out or asking them to sign in again.
