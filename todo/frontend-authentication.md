# Frontend: implement Authentik OIDC authentication

Implement Authentik OIDC login in the plain-JavaScript frontend using **Authorization Code Flow with PKCE**.

## Configuration

- Authentik issuer: `https://auth.loveandaman.com/application/o/<provider-slug>` (replace with the exact provider issuer URL)
- Client ID: `<Authentik application client ID>`
- Redirect URI: `https://loveandamanworkspace-pano-frontend-copy-production-b0b1.up.railway.app/auth/callback`
- API base URL: `<Railway operation-backend URL>`
- Scopes: `openid profile email`

Use OIDC discovery at:

```text
https://auth.loveandaman.com/application/o/<provider-slug>/.well-known/openid-configuration
```

## Requirements

1. Add a Login button that creates PKCE `state`, `code_verifier`, and S256 `code_challenge`, saves the state and verifier temporarily in `sessionStorage`, then redirects to Authentik’s authorization endpoint.
2. Implement `/auth/callback`: validate returned `state`; exchange the `code` and `code_verifier` at Authentik’s token endpoint; do not use a client secret.
3. Store tokens in memory where possible; clear them on logout. Do not commit secrets.
4. Add an API wrapper that adds `Authorization: Bearer <access_token>` to every operational backend request.
5. On `401`, attempt refresh-token renewal if available; otherwise clear the session and return to Login.
6. On `403`, show a permissions error. On `409`, show the backend’s insufficient-seat message.
7. Add logout that clears the local session and redirects to Authentik’s end-session endpoint if configured.
8. Add authenticated-user UI using token claims such as `name`, `email`, or `preferred_username`.

## Security boundary

Do not send user passwords or Google credentials to the backend. Authentik manages identity; the backend only receives and validates access tokens.
