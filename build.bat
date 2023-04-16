@echo off
@REM Chrome
rm -r dist/chrome/{assets,lib} dist/chrome.zip
cp -ru -t dist/chrome src/{assets,lib}
cp -u -t dist/chrome/popup src/popup/{index.html,styles.css}
cp -u src/manifest/chrome.json dist/chrome/manifest.json
cmd /C "babel src/popup/index.jsx  --out-dir dist/chrome/popup/ --presets @babel/preset-react,minify"
cmd /C "babel src/background/index.js --out-dir dist/chrome/background/ --presets minify"
cd dist/chrome && zip -rq ../chrome.zip * && cd ../..


@REM Firefox
rm -r dist/firefox/{assets,lib} dist/firefox.zip
cp -ru -t dist/firefox src/{assets,lib}
cp -u -t dist/firefox/popup src/popup/{index.html,styles.css}
cp -u src/manifest/firefox.json dist/firefox/manifest.json
cp -u -t dist/firefox/background/ src/background/index.html
cmd /C "babel src/popup/index.jsx  --out-dir dist/firefox/popup/ --presets @babel/preset-react,minify"
cmd /C "babel src/background/index.js --out-dir dist/firefox/background/ --presets minify"
cd dist/firefox && zip -rq ../firefox.zip * && cd ../../
