SHELL := /bin/bash
.SHELLFLAGS := -eu -o pipefail -c
.DEFAULT_GOAL := help

ENV ?= dev
LOCATION ?= eastus2
RG ?= rg-dpi-$(ENV)
BICEP_MAIN := infra/main.bicep
BICEP_PARAMS := infra/parameters/$(ENV).bicepparam

.PHONY: help install build test typecheck infra-validate infra-build infra-plan infra-deploy infra-clean

help:
	@echo "Common targets:"
	@echo "  install         pnpm install"
	@echo "  build           pnpm -r build"
	@echo "  test            vitest run"
	@echo "  typecheck       pnpm -r typecheck"
	@echo ""
	@echo "Infra (set ENV=dev|sandbox|prod; default ENV=$(ENV)):"
	@echo "  infra-build     bicep build (compiles to ARM JSON; no deploy)"
	@echo "  infra-validate  az deployment sub validate"
	@echo "  infra-plan      az deployment sub what-if  (dry-run, shows diff)"
	@echo "  infra-deploy    az deployment sub create   (DESTRUCTIVE — real Azure changes)"

install:
	pnpm install --frozen-lockfile

build:
	pnpm -r --filter "./packages/*" --filter "./apps/*" run build

typecheck:
	pnpm -r --filter "./packages/*" --filter "./apps/*" run typecheck

test:
	pnpm test

infra-build:
	az bicep build --file $(BICEP_MAIN)

infra-validate: infra-build
	az deployment sub validate \
	  --location $(LOCATION) \
	  --template-file $(BICEP_MAIN) \
	  --parameters $(BICEP_PARAMS) \
	  --parameters environmentName=$(ENV) resourceGroupName=$(RG) location=$(LOCATION)

infra-plan: infra-build
	az deployment sub what-if \
	  --location $(LOCATION) \
	  --template-file $(BICEP_MAIN) \
	  --parameters $(BICEP_PARAMS) \
	  --parameters environmentName=$(ENV) resourceGroupName=$(RG) location=$(LOCATION)

infra-deploy: infra-build
	@echo ">> Deploying to subscription [$$(az account show --query name -o tsv)] for ENV=$(ENV)"
	@read -p ">> Type the environment name '$(ENV)' to confirm: " confirm && [ "$$confirm" = "$(ENV)" ]
	az deployment sub create \
	  --location $(LOCATION) \
	  --template-file $(BICEP_MAIN) \
	  --parameters $(BICEP_PARAMS) \
	  --parameters environmentName=$(ENV) resourceGroupName=$(RG) location=$(LOCATION)

infra-clean:
	rm -f infra/**/*.json
