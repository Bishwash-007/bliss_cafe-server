# Agent Prompt: OTP / MFA

## Context
NestJS + PostgreSQL multi-tenant cafe SaaS. Add OTP abstraction for phone/email verification, passwordless, or MFA.

## Scope
Provider abstraction (SMS/email), request/verify flows, security controls.

## Design Patterns
- **Strategy + Adapter**: like PaymentProvider, support multiple OTP providers
- **Factory**: resolve provider per tenant/config
- **Rate limiting + state**: expiry, attempts, cooldowns

## Task
1. **Schema**: `otp_codes` (tenant_id, identifier hash/email/phone, code_hash, purpose, expires_at, attempts, verified_at, ip_hash)
2. **Provider interface**: `send(identifier, purpose): Promise<{ requestId }>` normalize responses
3. **Implementations**: Twilio/MSG91/email (SES/SendGrid) or stubs with clear errors
4. **API**: `POST /auth/otp/request`, `POST /auth/otp/verify` with purpose, rate limiting per identifier/IP
5. **Security**: hash codes, short expiry (e.g. 5 min), max attempts, resend cooldown, enumeration-safe responses
6. **Integration**: optional MFA for sensitive actions

## Acceptance Criteria
- [ ] Codes never stored plain text
- [ ] Expiry and attempt limits enforced
- [ ] Enumeration safe (same response regardless of existence)
- [ ] Rate limited
- [ ] Provider abstraction used
- [ ] Tests cover success/failure/expiry/attempts
- [ ] `curl.md` updated

## Notes
- Add env vars to `.env.example`
- Consider SMS costs and compliance
