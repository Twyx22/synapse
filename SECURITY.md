# Security policy

The current supported release line is 1.0.x. Older development snapshots are provided for reference, not maintained release lines.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting on this repository (Security → Report a vulnerability), if enabled. If it is unavailable, open a minimal public issue asking for a private reporting channel. Do not publish exploit details, credentials or private project data in an issue.

Include the affected version, environment, a minimal reproduction, the impact and any mitigation you have found. There is no guaranteed response-time SLA.

## Security boundaries

Synapse relies on OpenCode permissions and the local user's operating-system privileges. It is not a sandbox. Model output and historical memory are untrusted data. Diagnostic redaction is best effort; inspect exports before sharing. Backups and persistent run state can contain sensitive information. Local cooperative locks are not a distributed security boundary.

If you suspect a compromised installation, stop the service and preserve evidence. Review the plugin source, configuration and provider credentials before restarting.
