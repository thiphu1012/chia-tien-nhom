# Tally — Telegram setup helpers (SETUP.md steps 7 & 8).
#
# These wrap the one-off Telegram Bot API calls so you never hand-edit a token
# or URL into a shell again. Values are read from a local, gitignored env file
# (default: .env) — copy .env.example to .env and fill it in first.
#
#   make set-webhook     # Step 7 — point Telegram at the Worker
#   make menu            # Step 8 — set the menu button + slash commands
#   make webhook-info    # inspect the current webhook registration
#   make delete-webhook  # unregister the webhook (e.g. before re-pointing it)
#   make help            # list targets
#
# Point at a different env file with:  make set-webhook ENV_FILE=.dev.vars

ENV_FILE ?= .env

# Preamble every target runs: fail if the env file is missing, then export its
# vars into the recipe shell. `set -a` auto-exports each assignment sourced.
LOAD = set -eu; \
	[ -f "$(ENV_FILE)" ] || { echo "✗ $(ENV_FILE) not found — run: cp .env.example $(ENV_FILE) && \$$EDITOR $(ENV_FILE)"; exit 1; }; \
	set -a; . "./$(ENV_FILE)"; set +a

.DEFAULT_GOAL := help
.PHONY: help set-webhook menu menu-button commands webhook-info delete-webhook

help: ## List available targets
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
	  | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

set-webhook: ## Step 7 — register the webhook (Telegram -> Worker)
	@$(LOAD); \
	: "$${BOT_TOKEN:?set BOT_TOKEN in $(ENV_FILE)}"; \
	: "$${WEBHOOK_SECRET:?set WEBHOOK_SECRET in $(ENV_FILE)}"; \
	: "$${WEBAPP_URL:?set WEBAPP_URL in $(ENV_FILE)}"; \
	url="$${WEBAPP_URL%/}/webhook"; \
	echo "→ setWebhook url=$$url"; \
	curl -sS "https://api.telegram.org/bot$$BOT_TOKEN/setWebhook" \
	  --data-urlencode "url=$$url" \
	  --data-urlencode "secret_token=$$WEBHOOK_SECRET"; \
	echo

menu: menu-button commands ## Step 8 — menu button + slash commands (both)

menu-button: ## Step 8a — set the Mini App menu button
	@$(LOAD); \
	: "$${BOT_TOKEN:?set BOT_TOKEN in $(ENV_FILE)}"; \
	: "$${WEBAPP_URL:?set WEBAPP_URL in $(ENV_FILE)}"; \
	url="$${WEBAPP_URL%/}"; \
	echo "→ setChatMenuButton url=$$url"; \
	curl -sS "https://api.telegram.org/bot$$BOT_TOKEN/setChatMenuButton" \
	  -H "Content-Type: application/json" \
	  -d "{\"menu_button\":{\"type\":\"web_app\",\"text\":\"Tally\",\"web_app\":{\"url\":\"$$url\"}}}"; \
	echo

commands: ## Step 8b — register the slash-command list
	@$(LOAD); \
	: "$${BOT_TOKEN:?set BOT_TOKEN in $(ENV_FILE)}"; \
	echo "→ setMyCommands"; \
	curl -sS "https://api.telegram.org/bot$$BOT_TOKEN/setMyCommands" \
	  -H "Content-Type: application/json" \
	  -d '{"commands":[{"command":"start","description":"Mở Tally"},{"command":"newevent","description":"Tạo sự kiện mới cho nhóm"},{"command":"addmember","description":"Thêm thành viên vào sự kiện"},{"command":"tally","description":"Xem/đổi sự kiện đang dùng"},{"command":"help","description":"Hướng dẫn"}]}'; \
	echo

webhook-info: ## Inspect the current webhook (url, pending count, last error)
	@$(LOAD); \
	: "$${BOT_TOKEN:?set BOT_TOKEN in $(ENV_FILE)}"; \
	curl -sS "https://api.telegram.org/bot$$BOT_TOKEN/getWebhookInfo"; \
	echo

delete-webhook: ## Unregister the webhook
	@$(LOAD); \
	: "$${BOT_TOKEN:?set BOT_TOKEN in $(ENV_FILE)}"; \
	curl -sS "https://api.telegram.org/bot$$BOT_TOKEN/deleteWebhook"; \
	echo
