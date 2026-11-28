"""Smoke-test an installed WebExtension in actual Firefox browser chrome.

No account, external page, test-only extension permission, or modified package.
This supplements the DOM/popup mock tests; it does not prove macOS behavior.
"""
import functools
import hashlib
import http.server
import pathlib
import shutil
import tempfile
import threading

from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.firefox.service import Service
from selenium.webdriver.support.ui import WebDriverWait

ROOT = pathlib.Path(__file__).resolve().parents[1]
ADDON_ID = "virtual-page-find@kaaburgh"
WIDGET_ID = "virtual-page-find_kaaburgh-browser-action"

def main():
    packages = list((ROOT / "dist").glob("virtual-page-find-firefox-*.zip"))
    assert len(packages) == 1, packages
    package = packages[0].resolve()
    print("Testing", package.name, "sha256", hashlib.sha256(package.read_bytes()).hexdigest(), flush=True)
    with tempfile.TemporaryDirectory() as tmp:
        pathlib.Path(tmp, "index.html").write_text(
            '<!doctype html><title>Local extension fixture</title>'
            '<div style="height:1800px">Yesterday</div>', encoding="utf-8")
        handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=tmp)
        with http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler) as server:
            threading.Thread(target=server.serve_forever, daemon=True).start()
            try:
                options = Options()
                options.binary_location = shutil.which("firefox")
                service = Service(executable_path=shutil.which("geckodriver"),
                                  service_args=["--allow-system-access"])
                with webdriver.Firefox(options=options, service=service) as driver:
                    # A real Firefox instance (Xvfb display), with a fresh profile.
                    print("Firefox browserVersion", driver.capabilities.get("browserVersion"), flush=True)
                    addon_id = driver.install_addon(str(package), temporary=True)
                    assert addon_id == ADDON_ID, addon_id
                    driver.get("http://127.0.0.1:%d/" % server.server_port)
                    driver.set_context("chrome")
                    driver.execute_script("""
                        const {CustomizableUI} = ChromeUtils.importESModule(
                            "resource:///modules/CustomizableUI.sys.mjs");
                        CustomizableUI.addWidgetToArea(arguments[0], CustomizableUI.AREA_NAVBAR);
                    """, WIDGET_ID)
                    wait = WebDriverWait(driver, 15)
                    button = wait.until(lambda d: d.find_element(By.ID, WIDGET_ID))
                    button.click()
                    def open_popup(d):
                        return d.execute_script("""
                            for (const browser of document.querySelectorAll("browser")) {
                                const uri = browser.currentURI?.spec || "";
                                if (!uri.startsWith("moz-extension:") || !uri.endsWith("/popup.html")) continue;
                                const rect = browser.getBoundingClientRect();
                                const panel = browser.closest("panel");
                                if (panel?.state !== "open" || rect.width < 300 || rect.height < 100) continue;
                                return {width: rect.width, height: rect.height, panel: panel.id, state: panel.state};
                            }
                            return null;
                        """)
                    try:
                        popup = wait.until(open_popup)
                    except Exception:
                        print("Native popup diagnostics:", driver.execute_script("""
                            return Array.from(document.querySelectorAll("panel")).filter(
                                p => p.state !== "closed").map(p=>({id:p.id,state:p.state,
                                    browsers:Array.from(p.querySelectorAll("browser")).map(b=>({
                                        extensionPage:(b.currentURI?.spec||"").startsWith("moz-extension:"),
                                        popupPage:(b.currentURI?.spec||"").endsWith("/popup.html"),
                                        width:b.getBoundingClientRect().width,height:b.getBoundingClientRect().height
                                    }))}));
                        """), flush=True)
                        raise
                    print("Native toolbar popup opened:", popup, flush=True)
            finally:
                server.shutdown()

if __name__ == "__main__":
    main()
