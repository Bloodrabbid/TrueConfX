# Homebrew cask. Установка:
#   brew tap bloodrabbid/trueconfx https://github.com/Bloodrabbid/TrueConfX
#   brew install --cask trueconfx
cask "trueconfx" do
  arch arm: "arm64", intel: "x64"

  version "0.2.8"
  sha256 arm:   "6064632d3673dff6682a66f3620ed380fc3fed2c177b4ff63988fa05a21b4e62",
         intel: "8e48d5813eb387ac8cada38bc28f6d3678041d78281f3bfeb9c27dcf77a788d3"

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
