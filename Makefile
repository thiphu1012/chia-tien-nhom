# Tally — build/deploy + Telegram setup helpers.
#
# Deploy (uses your `wrangler login` session — no secrets in this file):
#   make deploy          # typecheck + test, then publish the Worker + Mini App
#   make dev             # run the Worker locally
#   make logs            # tail live Worker logs
#   make db-migrate      # apply the latest one-shot migration to remote D1
#
# Telegram setup (SETUP.md steps 7 & 8) — one-off Bot API calls. Values come from
# a local, gitignored env file (default .env) so you never paste a token into a
# shell. Copy .env.example to .env and fill it in first.
#   make set-webhook     # Step 7 — point Telegram at the Worker
#   make menu            # Step 8 — set the menu button + slash commands
#   make webhook-info    # inspect the current webhook registration
#   make delete-webhook  # unregister the webhook (e.g. before re-pointing it)
#   make help            # list every target
#
# Point at a different env file with:  make set-webhook ENV_FILE=.dev.vars

ENV_FILE ?= .env

# Preamble every Telegram target runs: fail if the env file is missing, then export
# its vars into the recipe shell. `set -a` auto-exports each assignment sourced.
LOAD = set -eu; \
	[ -f "$(ENV_FILE)" ] || { echo "✗ $(ENV_FILE) not found — run: cp .env.example $(ENV_FILE) && \$$EDITOR $(ENV_FILE)"; exit 1; }; \
	set -a; . "./$(ENV_FILE)"; set +a

.DEFAULT_GOAL := help
.PHONY: help check deploy dev logs login db-schema db-migrate \
	set-webhook menu menu-button commands webhook-info delete-webhook

help: ## List available targets
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
	  | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

# ---- build & deploy (no secrets: wrangler uses your `wrangler login` session) ----

check: ## Typecheck (tsc --noEmit) + run the test suite
	npx tsc --noEmit
	npm test

deploy: check ## Ship it: typecheck + test, then deploy the Worker + Mini App
	npx wrangler deploy

dev: ## Run the Worker locally (needs .dev.vars with DEV_MODE="true"; open /?dev=1:You)
	npm run dev

logs: ## Tail live Worker logs (Ctrl-C to stop)
	npx wrangler tail

login: ## Authenticate wrangler with Cloudflare (one-time OAuth, no token stored here)
	npx wrangler login

db-schema: ## Apply schema.sql to the REMOTE D1 database (fresh install)
	npm run db:remote

db-migrate: ## Apply the latest one-shot migration to the REMOTE D1 (see migrations/)
	npm run db:migrate:remote

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
	  -d '{"commands":[{"command":"start","description":"Mở Tally"},{"command":"newevent","description":"Tạo sự kiện mới cho nhóm"},{"command":"addmember","description":"Thêm thành viên vào sự kiện"},{"command":"tally","description":"Xem/đổi sự kiện đang dùng"},{"command":"quyettoan","description":"Quyết toán: ai trả ai + thông tin chuyển khoản"},{"command":"help","description":"Hướng dẫn"}]}'; \
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
