#!/usr/bin/env bash
# Обновляет рецепты под новую версию: PKGBUILD для Arch и cask для Homebrew.
# Берёт sha256 из готовых установщиков. Запуск: packaging/update-recipes.sh 0.2.4 папка_с_файлами
set -euo pipefail
ver="$1"; dist="$2"
root="$(cd "$(dirname "$0")/.." && pwd)"
# В контейнере Arch нет shasum (он из perl), а на macOS нет sha256sum.
sum() { if command -v sha256sum >/dev/null; then sha256sum "$dist/$1"; else shasum -a 256 "$dist/$1"; fi | cut -d' ' -f1; }
deb=$(sum "TrueConfX-$ver-linux-amd64.deb")
arm=$(sum "TrueConfX-$ver-mac-arm64.dmg")
intel=$(sum "TrueConfX-$ver-mac-x64.dmg")

cat > "$root/packaging/arch/PKGBUILD" <<PKG
# Maintainer: Bloodrabbid <Bloodrabbid@users.noreply.github.com>
# Пакет собирается из .deb релиза: внутри уже готовое Electron-приложение.
pkgname=trueconfx-bin
pkgver=$ver
pkgrel=1
pkgdesc='Неофициальный современный клиент для TrueConf Server'
arch=('x86_64')
url='https://github.com/Bloodrabbid/TrueConfX'
license=('custom')
depends=('gtk3' 'nss' 'alsa-lib' 'libxss' 'libxtst' 'libnotify' 'libsecret' 'xdg-utils' 'at-spi2-core' 'util-linux-libs')
optdepends=('libappindicator-gtk3: значок в трее')
provides=('trueconfx')
conflicts=('trueconfx')
options=('!strip' '!debug')
source=("TrueConfX-\${pkgver}.deb::\${url}/releases/download/v\${pkgver}/TrueConfX-\${pkgver}-linux-amd64.deb")
sha256sums=('$deb')
noextract=("TrueConfX-\${pkgver}.deb")

package() {
  bsdtar -xOf "TrueConfX-\${pkgver}.deb" 'data.tar.*' | bsdtar -xf - -C "\$pkgdir"
  rm -rf "\$pkgdir/usr/share/doc"
  install -d "\$pkgdir/usr/bin"
  ln -s /opt/TrueConfX/trueconfx "\$pkgdir/usr/bin/trueconfx"
  # Песочница Chromium нужна на ядрах без user namespaces (например, linux-hardened).
  chmod 4755 "\$pkgdir/opt/TrueConfX/chrome-sandbox"
}
PKG

cat > "$root/Casks/trueconfx.rb" <<CASK
# Homebrew cask. Установка:
#   brew tap bloodrabbid/trueconfx https://github.com/Bloodrabbid/TrueConfX
#   brew install --cask trueconfx
cask "trueconfx" do
  arch arm: "arm64", intel: "x64"

  version "$ver"
  sha256 arm:   "$arm",
         intel: "$intel"

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
CASK
echo "Рецепты обновлены до $ver"
