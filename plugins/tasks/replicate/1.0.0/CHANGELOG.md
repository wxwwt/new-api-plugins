---
changelogVersion: 1
plugin: "replicate"
version: "1.0.0"
locale: "en"
---
# Changelog

## [1.0.0]

### Added

- Generate and edit images with Replicate's Flux 1.1 Pro and GPT Image 2 models through the OpenAI Images API.
- Send a model's native `input` fields without adding Flux settings, and continue polling predictions that are still running after the initial response.
- Use the plugin on existing Replicate channels or a New API channel connected to another gateway with this plugin installed.

### Migration

- Configure image prices for the plugin's `image_count` usage field before routing requests to it; image billing now reserves the requested count and settles against the completed output count.
- Install and activate this plugin on both gateways when routing Replicate images through another New API instance.
- Set `TASK_PLUGIN_PROTOCOL_TIMEOUT_SECONDS` to 1200 if image requests must wait up to 20 minutes for a completed response; the default is 600 seconds.
- Provide hosted image URLs for edit files larger than 1 MiB; smaller multipart uploads are sent as data URLs.
