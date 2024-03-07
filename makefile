.PHONY: chrome firefox all

all: chrome firefox

chrome:
	@rm -rf dist/chrome/assets dist/chrome/lib dist/chrome.zip
	@cp -ru src/assets src/lib dist/chrome
	@cp -u src/popup/index.html src/popup/styles.css dist/chrome/popup
	@cp -u src/manifest/chrome.json dist/chrome/manifest.json
	@node_modules/.bin/babel src/popup/index.jsx --out-dir dist/chrome/popup/ --presets @babel/preset-react,minify
	@node_modules/.bin/babel src/background/index.js --out-dir dist/chrome/background/ --presets minify
	@cd dist/chrome && zip -rq ../chrome.zip * && cd ..

firefox:
	@rm -rf dist/firefox/assets dist/firefox/lib dist/firefox.zip
	@cp -ru src/assets src/lib dist/firefox
	@cp -u src/popup/index.html src/popup/styles.css dist/firefox/popup
	@cp -u src/manifest/firefox.json dist/firefox/manifest.json
	@cp -u src/background/index.html dist/firefox/background/
	@node_modules/.bin/babel src/popup/index.jsx --out-dir dist/firefox/popup/ --presets @babel/preset-react,minify
	@node_modules/.bin/babel src/background/index.js --out-dir dist/firefox/background/ --presets minify
	@cd dist/firefox && zip -rq ../firefox.zip * && cd ..