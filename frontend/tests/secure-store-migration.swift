import Foundation
import CoreFoundation
let kSecValueData = "value" as CFString
let kSecAttrAccessible = "accessible" as CFString
let kSecUseOperationPrompt = "prompt" as CFString
let errSecSuccess: Int32 = 0
var stored: [String: Any] = ["value": Data("existing-key".utf8), "accessible": "when-unlocked"]
func SecItemUpdate(_ query: CFDictionary, _ attributes: CFDictionary) -> Int32 {
  for (key, value) in attributes as! [String: Any] { stored[key] = value }
  return errSecSuccess
}
struct SecureStoreOptions {
  var requireAuthentication = false
  var authenticationPrompt: String? = nil
}
struct KeyChainException: Error { init(_ status: Int32) {} }
class Store {
  func query(with key: String, options: SecureStoreOptions, requireAuthentication: Bool) -> [String: Any] { ["key": key] }
  func attributeWith(options: SecureStoreOptions) -> String { "after-first-unlock-device-only" }
  // UPDATE_METHOD
  func migrate(authenticated: Bool = false) throws {
    _ = try update(value: "existing-key", with: "identity", options: SecureStoreOptions(requireAuthentication: authenticated))
  }
}
try Store().migrate()
assert(stored["accessible"] as? String == "after-first-unlock-device-only")
assert(stored["value"] as? Data == Data("existing-key".utf8))
stored["accessible"] = "biometric-access-control"
try Store().migrate(authenticated: true)
assert(stored["accessible"] as? String == "biometric-access-control")
print("Existing key migrated without changing bytes; authenticated access preserved")
