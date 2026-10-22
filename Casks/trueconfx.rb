# Homebrew cask. Установка:
#   brew tap bloodrabbid/trueconfx https://github.com/Bloodrabbid/TrueConfX
#   brew install --cask trueconfx
cask "trueconfx" do
  arch arm: "arm64", intel: "x64"

  version "0.2.3"
  sha256 arm:   "8be631ec33829fbfaaf8386aaf49e1216d7f9a2e87a845f2efe00c36096f328e",
         intel: "c75380391c37026effb0cf2ee1a6cc64d14ac7e7c5c5b19fc24d364736a49c91"

  url "https://github.com/Bloodrabbid/TrueConfX/releases/download/v#{version}/TrueConfX-#{version}-mac-#{arch}.dmg"
  name "TrueConfX"
  desc "Unofficial modern client for TrueConf Server"
  homepage "https://github.com/Bloodrabbid/TrueConfX"

  livecheck do
    url :url
    strategy :github_latest
  end

  depends_on macos: ">= :ventura"

  app "TrueConfX.app"

  # Приложение не подписано сертификатом Apple: снимаем карантин, иначе macOS не даст его открыть.
  postflight do
    system_command "/usr/bin/xattr",
                   args: ["-dr", "com.apple.quarantine", "#{appdir}/TrueConfX.app"]
  end

  zap trash: [
    "~/Library/Application Support/TrueConfX",
    "~/Library/Logs/TrueConfX",
    "~/Library/Preferences/ru.local.trueconfx.plist",
    "~/Library/Saved Application State/ru.local.trueconfx.savedState",
  ]
end
