# Homebrew cask. Установка:
#   brew tap bloodrabbid/trueconfx https://github.com/Bloodrabbid/TrueConfX
#   brew install --cask trueconfx
cask "trueconfx" do
  arch arm: "arm64", intel: "x64"

  version "0.2.5"
  sha256 arm:   "44211f0672734715e9a966ccf0f2c60ddc7944a94f40561f870d9f9a85702379",
         intel: "7ddc6b06efaa6e6afa1a71ce1df8e418ca9e382db9691cf76377d655aed27b18"

  url "https://github.com/Bloodrabbid/TrueConfX/releases/download/v#{version}/TrueConfX-#{version}-mac-#{arch}.dmg"
  name "TrueConfX"
  desc "Unofficial modern client for TrueConf Server"
  homepage "https://github.com/Bloodrabbid/TrueConfX"

  livecheck do
    url :url
    strategy :github_latest
  end

  depends_on macos: :ventura

  app "TrueConfX.app"

  # Приложение не подписано сертификатом Apple: снимаем карантин, иначе macOS не даст его открыть.
  postflight_steps do
    run "/usr/bin/xattr",
        args:           ["-dr", "com.apple.quarantine", "{{appdir}}/TrueConfX.app"],
        writable_paths: ["{{appdir}}/TrueConfX.app"]
  end

  zap trash: [
    "~/Library/Application Support/TrueConfX",
    "~/Library/Logs/TrueConfX",
    "~/Library/Preferences/ru.local.trueconfx.plist",
    "~/Library/Saved Application State/ru.local.trueconfx.savedState",
  ]
end
