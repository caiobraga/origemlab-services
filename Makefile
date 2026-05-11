SHELL := /bin/bash

GO ?= go
OUT ?= .out

.PHONY: clean test build telegram-notifier error-reporter sam-build build-TelegramNotifierFunction build-ErrorReporterFunction

clean:
	rm -rf $(OUT)

test:
	$(GO) test ./...

build: telegram-notifier error-reporter

telegram-notifier:
	mkdir -p $(OUT)/telegram-notifier
	GOOS=linux GOARCH=amd64 $(GO) build -o $(OUT)/telegram-notifier/bootstrap ./cmd/telegram-notifier

error-reporter:
	mkdir -p $(OUT)/error-reporter
	GOOS=linux GOARCH=amd64 $(GO) build -o $(OUT)/error-reporter/bootstrap ./cmd/error-reporter

sam-build: build
	@echo "Built lambdas into $(OUT)/"

build-TelegramNotifierFunction:
	GOOS=linux GOARCH=amd64 CGO_ENABLED=0 $(GO) build -o "$(ARTIFACTS_DIR)/bootstrap" ./cmd/telegram-notifier

build-ErrorReporterFunction:
	GOOS=linux GOARCH=amd64 CGO_ENABLED=0 $(GO) build -o "$(ARTIFACTS_DIR)/bootstrap" ./cmd/error-reporter

