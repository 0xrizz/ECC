# Optional ECC CLI Usage Telemetry

ECC's default remains local-first: CLI usage telemetry is off unless a user
explicitly runs `ecc telemetry enable`. Installing or updating the npm package
does not enable telemetry, create an identifier, or make a telemetry request.
The package has no `preinstall`, `install`, or `postinstall` telemetry hook.

This client is an endpoint-gated candidate. The public package does not contain
a default collection endpoint. An event can leave the machine only when both
of these conditions are true:

1. the user has run `ecc telemetry enable`; and
2. `ECC_TELEMETRY_ENDPOINT` names a valid HTTPS endpoint.

Do not add a default endpoint until an owner has published the privacy notice,
reviewed the lawful basis and processor contracts, and verified the server-side
retention, deletion, and source-IP controls below.

## User Controls

```bash
ecc telemetry status
ecc telemetry preview --command consult --result success --latency-ms 250
ecc telemetry schema
ecc telemetry enable
ecc telemetry disable
ecc telemetry delete
ecc telemetry delete --local-only
ECC_TELEMETRY=0 ecc doctor
```

- `status` shows persisted consent, effective collection, endpoint readiness,
  identifier presence, rotation, and retention without printing a local path
  or identifier.
- `preview` builds an ephemeral, local-only event without persisting consent or
  sending a request.
- `schema` prints the event allowlist in
  `schemas/ecc-cli-telemetry-event.schema.json`.
- `enable` is the only way to persist consent. Setting an environment variable
  cannot opt a user in.
- `disable` stops future collection and retains only the rotating identities
  and bound endpoints needed for a later remote deletion request.
- Before an event is sent, its rotating identifier is durably bound to the
  normalized endpoint that will receive it. `delete` sends the deletion
  contract to every original bound endpoint and clears only endpoint/identifier
  bindings whose deletion succeeded. Partial failures remain locally retryable.
- `delete --local-only` clears local state without making a request.
- `ECC_TELEMETRY=0` is a hard override, including for remote deletion. Remove
  the override temporarily or use `--local-only` if deletion is required.

## Complete Event Allowlist

The event has `additionalProperties: false` and contains only:

| Field | Value |
| --- | --- |
| `schemaVersion` | Fixed schema identifier |
| `anonymousId` | Random UUID rotated every 30 days |
| `packageName` / `packageVersion` | Published ECC package and version |
| `commandId` | Allowlisted sponsor-neutral top-level command or `other` |
| `result` | `success` or `failure` |
| `latencyBucket` | One of four coarse duration ranges |
| `os` | `macos`, `linux`, `windows`, or `other` |
| `arch` | `arm64`, `x64`, or `other` |

There is no event timestamp; the ingestion service can use receipt time. ECC
does not capture or send command arguments, prompts, file paths, usernames,
repository names, hostnames, IP addresses as an event field, credentials,
cookies, RFQs, supplier details, demand details, prices, or quantities.

The sponsor-specific `ito` command is deliberately excluded from collection;
telemetry cannot measure sponsor or RFQ usage.

HTTP necessarily exposes a source address to the receiving network edge. The
ingestion service must disable source-IP storage in access logs and analytics,
must not enrich events with geolocation or organization identity, and must not
set cookies or join this identifier to account, marketing, RFQ, or billing data.

## Endpoint Contract

`ECC_TELEMETRY_ENDPOINT` must use HTTPS and cannot contain credentials, a query
string, or a fragment. The client binds the normalized endpoint to the
identifier before attempting delivery, so changing the environment later
cannot redirect a deletion request away from the original recipient. The
client sends:

- `POST` with `ecc.cli-telemetry.v1`; or
- `DELETE` with `ecc.cli-telemetry-deletion.v1`.

Delivery is best-effort, has a 750 ms timeout, and never changes the wrapped
command's result. Failed events are dropped rather than queued on disk.
Cross-process state locking serializes rotation, delivery, and deletion so an
emitted identifier remains covered by deletion and a deletion cannot race a
later event. The server must:

- enforce the public schemas and reject additional properties;
- retain raw pseudonymous events for no more than 30 days;
- delete matching raw events when it accepts a deletion request;
- strip the rotating identifier before retaining longer-lived aggregate
  counts;
- suppress small cohorts before publishing breakdowns; and
- publish current controller, processor, contact, purpose, retention, and
  deletion information.

The client displaying a 30-day ceiling does not prove server compliance. A
default endpoint must remain absent until these controls are independently
verified.

## What The Analytics Can And Cannot Answer

npm exposes package-level download counts, which can help measure aggregate
adoption, but those counts do not reveal which ECC commands or workflows were
used. Explicitly opted-in CLI events can estimate aggregate command usage,
failure rates, broad performance buckets, and platform compatibility needs.
They are a self-selected sample, not a user census, and must not be used to
identify or target individual people, companies, repositories, suppliers, or
demand.

Relevant primary sources:

- [npm package search and aggregate download-count sorting](https://docs.npmjs.com/searching-for-and-choosing-packages-to-download/)
- [npm lifecycle-script behavior](https://docs.npmjs.com/cli/using-npm/scripts/)
- [GDPR Articles 5, 6, 13, and 25](https://eur-lex.europa.eu/eli/reg/2016/679/oj)
- [California Privacy Protection Agency data-minimization advisory](https://cppa.ca.gov/pdf/enfadvisory202401.pdf)

This design is a technical minimization baseline, not legal advice. Consent
does not by itself settle jurisdiction, controller obligations, employee-use
issues, international transfers, or whether a pseudonymous identifier is
personal information. Counsel should review the final endpoint, notice, and
retention implementation before any public collection endpoint is configured.
