# Homebrew cask. Установка:
#   brew tap bloodrabbid/trueconfx https://github.com/Bloodrabbid/TrueConfX
#   brew install --cask trueconfx
cask "trueconfx" do
  arch arm: "arm64", intel: "x64"

  version "0.2.9"
  sha256 arm:   "9f602d13a7add31bf0b06ed7c6253b1af6c1d4beaedd0492a0f4c3cf7b75fb3d",
         intel: "c89406dfe698bee060b2f25b3857dfafc11f8d247d9ba9cd14565b622998d6a0"

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
