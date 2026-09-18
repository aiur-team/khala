# Human control composition

This directory is the server-side composition boundary for human routes.
`registerHumanHandlers()` supplies the runtime's finite list of
`RouteRegistration` values under `/api/human/*`; the runtime validates the list
and generates the single Netlify function entrypoint. There is no filesystem,
plugin, or request-driven handler discovery.

Handlers bind production adapters lazily for each request and perform no
network work while their module is imported. Verified server-side identity is
the source of owner authority. A request body, query parameter, route value,
or browser model can never provide or replace that authority.

Deployment endpoints and credentials come from the control runtime's validated
environment configuration. They stay inside adapter closures and must not be
returned in response models, logged, copied into the browser route context, or
captured in test fixtures. A configured route with an unavailable dependency
returns an explicit unavailable response; it never falls back to a fixture or
claims success.

The generated gateway owns method checks, exact-path dispatch, mutation-origin
validation, bounded bodies, and sanitized errors. Human handlers own domain
authentication and authorization. Both layers return disposables or
request-scoped resources to their owner rather than creating process-global
device or messaging clients.
