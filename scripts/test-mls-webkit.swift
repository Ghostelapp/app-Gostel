// Standalone macOS WebKit smoke test of the exact bundled mobile runtime.
// Run: swift scripts/test-mls-webkit.swift /absolute/path/to/runtime.html
import AppKit
import WebKit

final class MLSWebKitTest: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
    var web: WKWebView!
    var phase = 0
    var current = "alice"
    var states: [String:String] = [:]
    var identities: [String:[String:Any]] = [:]
    var package = ""
    var welcome = ""
    var wire = ""
    var chunks: [Int:String] = [:]
    let body = String(repeating: "WebKit verified exchange ", count: 2500)
    func device(_ name: String) -> [String:String] { ["user_id":name,"device_id":name + "-webkit"] }
    var roster: [[String:String]] { [device("alice"),device("bob")] }
    func issue(_ user: String, _ command: [String:Any]) {
        current = user
        let request: [String:Any] = ["device":device(user),"master":Data(repeating:7,count:32).base64EncodedString(),"state":states[user] as Any? ?? NSNull(),"command":command]
        do {
            let input = String(data:try JSONSerialization.data(withJSONObject:request),encoding:.utf8)!
            let chars = Array(input)
            let total = (chars.count + 65535) / 65536
            for part in 0..<total {
                let chunk = String(chars[(part * 65536)..<min(chars.count, (part + 1) * 65536)])
                let payload = String(data:try JSONSerialization.data(withJSONObject:["id":phase,"part":part,"total":total,"chunk":chunk]),encoding:.utf8)!
                web.evaluateJavaScript("globalThis.receiveMLSChunk(\(payload)); true;") { _, error in
                    if error != nil { print("WebKit: runtime evaluation failed"); exit(1) }
                }
            }
        } catch { print("WebKit: serialization failed"); exit(1) }
    }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard var event = message.body as? [String:Any] else { return }
        if event["chunked"] as? Bool == true {
            guard let part = event["part"] as? Int, let total = event["total"] as? Int, let chunk = event["chunk"] as? String else { exit(1) }
            chunks[part] = chunk
            if chunks.count < total { return }
            let json = (0..<total).map { chunks[$0]! }.joined()
            chunks.removeAll()
            guard let data = json.data(using:.utf8), let assembled = try? JSONSerialization.jsonObject(with:data) as? [String:Any] else { exit(1) }
            event = assembled
        }
        if event["ready"] as? Bool == true { issue("alice",["op":"identity"]); return }
        guard let raw = event["result"] as? String, let data = raw.data(using:.utf8), let result = try? JSONSerialization.jsonObject(with:data) as? [String:Any], let state = result["state"] as? String else {
            print("WebKit: MLS operation failed"); exit(1)
        }
        states[current] = state
        let output = result["output"]
        phase += 1
        switch phase {
        case 1: identities["alice"] = output as? [String:Any]; issue("bob",["op":"identity"])
        case 2: identities["bob"] = output as? [String:Any]; issue("alice",["op":"verify","peer":identities["bob"]!])
        case 3: issue("bob",["op":"verify","peer":identities["alice"]!])
        case 4: issue("bob",["op":"key_package"])
        case 5: package = output as! String; issue("alice",["op":"create","conversation":"webkit-room"])
        case 6: issue("alice",["op":"add","conversation":"webkit-room","packages":[package],"roster":roster])
        case 7: welcome = (output as! [String:Any])["welcome"] as! String; issue("alice",["op":"accept","conversation":"webkit-room","roster":roster])
        case 8: issue("bob",["op":"join","conversation":"webkit-room","welcome":welcome,"roster":roster])
        case 9: issue("alice",["op":"encrypt","conversation":"webkit-room","body":body,"roster":roster])
        case 10: wire = output as! String; issue("bob",["op":"receive","conversation":"webkit-room","message":wire,"roster":roster])
        case 11:
            guard (output as? [String:Any])?["body"] as? String == body else { print("WebKit: plaintext mismatch"); exit(1) }
            print("PASS: bundled WASM, secure randomness, CSP, chunked IPC and 60KB MLS exchange in macOS WKWebView")
            exit(0)
        default: exit(1)
        }
    }
    func start(_ html: String) {
        let config = WKWebViewConfiguration()
        config.userContentController.add(self,name:"mls")
        web = WKWebView(frame:NSRect(x:0,y:0,width:1,height:1),configuration:config)
        web.navigationDelegate = self
        web.loadHTMLString(html,baseURL:URL(string:"https://ghostel.invalid/"))
    }
}
let application = NSApplication.shared
application.setActivationPolicy(.prohibited)
let tester = MLSWebKitTest()
guard CommandLine.arguments.count == 2, let html = try? String(contentsOfFile:CommandLine.arguments[1],encoding:.utf8) else { print("Pass a local runtime HTML fixture"); exit(1) }
tester.start(html)
DispatchQueue.main.asyncAfter(deadline:.now()+45) { print("WebKit: test timeout"); exit(1) }
application.run()
