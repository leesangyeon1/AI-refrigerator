// Native macOS shell for AI Refrigerator: a WKWebView window that owns the local
// server as a child process. No browser, no Electron — one compiled binary.
import Cocoa
import WebKit

let defaultPort = 4924

func findNode() -> String? {
    let fm = FileManager.default
    for p in ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"]
    where fm.isExecutableFile(atPath: p) { return p }
    // GUI apps don't inherit a shell PATH, so nvm installs need an explicit look
    let nvm = NSHomeDirectory() + "/.nvm/versions/node"
    if let versions = try? fm.contentsOfDirectory(atPath: nvm) {
        for v in versions.sorted(by: >) {
            let p = "\(nvm)/\(v)/bin/node"
            if fm.isExecutableFile(atPath: p) { return p }
        }
    }
    return nil
}

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate {
    var window: NSWindow!
    var webView: WKWebView!
    var server: Process?
    var url: URL { URL(string: "http://127.0.0.1:\(defaultPort)")! }

    func applicationDidFinishLaunching(_ note: Notification) {
        buildMenu()
        buildWindow()
        guard startServer() else { return }
        waitForServer()
    }

    func buildWindow() {
        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1280, height: 860),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered, defer: false)
        window.title = "AI Refrigerator"
        window.minSize = NSSize(width: 900, height: 600)
        window.center()
        window.setFrameAutosaveName("MainWindow")

        webView = WKWebView(frame: window.contentView!.bounds, configuration: WKWebViewConfiguration())
        webView.autoresizingMask = [.width, .height]
        webView.navigationDelegate = self
        webView.uiDelegate = self
        window.contentView!.addSubview(webView)
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func startServer() -> Bool {
        let appDir = Bundle.main.resourceURL!.appendingPathComponent("app")
        guard FileManager.default.fileExists(atPath: appDir.appendingPathComponent("server.js").path) else {
            alert("This build is missing its app payload. Re-download AI Refrigerator.")
            return false
        }
        guard let node = findNode() else {
            alert("Node.js 18 or newer is required.\n\nInstall it from nodejs.org (or `brew install node`) and open AI Refrigerator again.")
            return false
        }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: node)
        p.arguments = ["server.js", "--no-open", "--port", String(defaultPort)]
        p.currentDirectoryURL = appDir
        do { try p.run() } catch {
            alert("Could not start the local server:\n\(error.localizedDescription)")
            return false
        }
        server = p
        return true
    }

    // The server needs a moment to bind; poll rather than guess with a sleep
    func waitForServer(attempt: Int = 0) {
        var req = URLRequest(url: url.appendingPathComponent("api/catalog"))
        req.timeoutInterval = 2
        URLSession.shared.dataTask(with: req) { _, response, _ in
            let ok = (response as? HTTPURLResponse)?.statusCode == 200
            DispatchQueue.main.async {
                if ok {
                    self.webView.load(URLRequest(url: self.url))
                } else if attempt < 40 {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) {
                        self.waitForServer(attempt: attempt + 1)
                    }
                } else {
                    self.alert("The local server did not start in time.")
                }
            }
        }.resume()
    }

    // Links to GitHub and friends open in the real browser, not inside the app
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let target = navigationAction.request.url, target.host != "127.0.0.1" {
            NSWorkspace.shared.open(target)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let target = navigationAction.request.url { NSWorkspace.shared.open(target) }
        return nil
    }

    func alert(_ message: String) {
        let a = NSAlert()
        a.messageText = "AI Refrigerator"
        a.informativeText = message
        a.alertStyle = .critical
        a.runModal()
        NSApp.terminate(nil)
    }

    func buildMenu() {
        let main = NSMenu()
        let appItem = NSMenuItem()
        main.addItem(appItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "About AI Refrigerator", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Reload", action: #selector(reload), keyEquivalent: "r")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Hide AI Refrigerator", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(withTitle: "Quit AI Refrigerator", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu

        let editItem = NSMenuItem()
        main.addItem(editItem)
        let edit = NSMenu(title: "Edit")
        for (t, s, k) in [("Cut", #selector(NSText.cut(_:)), "x"), ("Copy", #selector(NSText.copy(_:)), "c"),
                          ("Paste", #selector(NSText.paste(_:)), "v"), ("Select All", #selector(NSText.selectAll(_:)), "a")] {
            edit.addItem(withTitle: t, action: s, keyEquivalent: k)
        }
        editItem.submenu = edit
        NSApp.mainMenu = main
    }

    @objc func reload() { webView.reload() }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    // Quitting must not leave an orphaned server holding the port
    func applicationWillTerminate(_ note: Notification) {
        server?.terminate()
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
