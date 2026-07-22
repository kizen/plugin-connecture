# Connecture App

A [Kizen](https://kizen.com) CRM plugin that integrates with [Connecture](https://www.connecture.com/agents/) to let agents launch Medicare plan quoting sessions directly from a contact record.

## What it does

The plugin adds a **Start Quoting in Connecture** action to contact records. When run, it:

1. Reads the agent's NPN from their employee configuration and the business's Connecture environment entitlement.
2. Maps the contact's fields (name, address, phone, Medicare number, etc.) to the format Connecture expects.
3. Creates a quoting session with Connecture and searches for existing member records by Medicare number, letting the agent pick a match or create a new one.
4. Pulls related pharmacy, provider, and drug records from the contact and attaches them to the session.
5. Links a `sunfire_saved_sessions` record back to the contact so future quoting sessions can find the same Connecture member.
6. Opens Connecture via SSO with the session pre-populated.

## Structure

```
kizen.json                     Plugin manifest: metadata, environments, and service definitions
src/actions/startQuoting/      The "Start Quoting in Connecture" action
  config.json                  Action metadata (name, api_name, target object)
  script.js                    Action implementation
releaseNotes/                  Per-version release notes shown in the Kizen plugin marketplace
```

## Configuration

The plugin supports two Connecture environments, selected automatically based on the business's entitlements:

- `connecture_integration_jsastaging` — staging
- `connecture_integration_jsa` — production

Each environment's service credentials (auth URL, client credentials, base service URL) live in `kizen.json` under `services`, keyed by `required_entitlement`, and are meant to be provisioned per-deployment.

## Requirements

- The agent's Kizen employee record must have an NPN configured under the plugin config.
- The contact record must have the required address fields (street address, city, state, zip) before a session can be created.
