# Requirements log

| ID | Date | Status | Requirement / decision | Rationale | Affected artifacts | Validation |
|---|---|---|---|---|---|---|
| R-001 | 2026-10-05 | active | The CRM/exhibitions application owns its domain APIs and data. The agent consumes a versioned contract; it is not coupled to CRM internals. | Keep product domain ownership in the second-order service and make integration boundaries explicit. | API manifest, service, schemas | Contract checks assert the versioned manifest and exposed capabilities. |
| R-002 | 2026-10-05 | active | This repository must not connect to live D1/CRM storage, perform CRM writes, or contain credentials or private catalog snapshots. Fixtures in this slice are clearly synthetic. | Safe, reviewable foundation while real integration and data handling are designed separately. | Fixtures, service, README | Behavior checks exercise only local synthetic fixtures; source scan checks for prohibited connection/write patterns. |
| R-003 | 2026-10-05 | active | Existing static `flexi-consulting/exhibitions` and `flexi-crm-automation` are distinct sources to integrate later; do not move or edit them as part of this slice. | Preserve their separate ownership and defer integration design to a later reviewed change. | README | Documented integration boundary. |
