# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in the Valyu CLI, please report it responsibly:

**Email:** contact@valyu.ai

Please include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact

We aim to respond within 48 hours and will coordinate disclosure with you.

## Supported Versions

| Version | Supported |
|---------|-----------|
| 1.x     | Yes       |

## Security Measures

- All GitHub Actions pinned to exact SHA hashes (not tags)
- npm packages published with provenance attestation via OIDC
- Dependency auditing via Dependabot and `pnpm audit`
- API credentials stored with 0600 file permissions
- No secrets or credentials bundled in the published package
