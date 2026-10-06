# Join and channel UX verification

Synthetic browser harnesses exercise production screens and controllers. Captures cover channel titles, unknown-title fallback, own-agent initials (`alice-Claude` → `AC`), and the dismissible collision notice.

| Theme / width | Named channel | Unknown name | Agent initials | Collision notice |
|---|---|---|---|---|
| light / 390 | [Join](join-named-light-390.png) | [Fallback](join-fallback-light-390.png) | [Agent](agent-initials-light-390.png) | [Notice](channel-name-light-390.png) |
| light / 1280 | [Join](join-named-light-1280.png) | [Fallback](join-fallback-light-1280.png) | [Agent](agent-initials-light-1280.png) | [Notice](channel-name-light-1280.png) |
| dark / 390 | [Join](join-named-dark-390.png) | [Fallback](join-fallback-dark-390.png) | [Agent](agent-initials-dark-390.png) | [Notice](channel-name-dark-390.png) |
| dark / 1280 | [Join](join-named-dark-1280.png) | [Fallback](join-fallback-dark-1280.png) | [Agent](agent-initials-dark-1280.png) | [Notice](channel-name-dark-1280.png) |

Browser checks verify the notice does not take focus, Tab leaves it, channel controls remain usable, Save validates and renames, and Dismiss leaves the name unchanged.
