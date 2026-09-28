.PHONY: install test test-py test-js lint format demo

install:
	pip install -r requirements-dev.txt
	npm ci

test: lint test-py test-js

test-py:
	python3 -m pytest

test-js:
	npm test

lint:
	ruff check .
	ruff format --check .
	npx prettier --check "**/*.{mjs,js,json,css,html}"

format:
	ruff format .
	ruff check --fix .
	npx prettier --write "**/*.{mjs,js,json,css,html}"

# End-to-end dry run on a synthetic image, with a fake "image model".
demo:
	mkdir -p work/demo
	python3 tools/make_synthetic.py work/demo/source.png 1200 800
	printf '%s\n' '{"input":"source.png","workDir":"refine","target":{"width":1800,"height":1200},"tile":{"size":512,"overlap":128},"protected":[[700,500,300,200]]}' > work/demo/refine.json
	node refine/prepare.mjs work/demo/refine.json
	python3 tools/fake_generate.py work/demo/refine
	python3 refine/register.py work/demo/refine.json
	node refine/assemble.mjs work/demo/refine.json --force
	node refine/verify.mjs work/demo/refine.json
