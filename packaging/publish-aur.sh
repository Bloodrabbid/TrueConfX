#!/usr/bin/env bash
# Выкладывает trueconfx-bin в AUR: клонирует репозиторий пакета, кладёт PKGBUILD и .SRCINFO, пушит.
# Нужен аккаунт на aur.archlinux.org с публичным SSH-ключом (Host aur.archlinux.org в ~/.ssh/config).
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
git clone -q ssh://aur@aur.archlinux.org/trueconfx-bin.git "$work/aur"
cp "$root/packaging/arch/PKGBUILD" "$root/packaging/arch/.SRCINFO" "$work/aur/"
cd "$work/aur"
ver=$(sed -n 's/^\tpkgver = //p' .SRCINFO)
git add PKGBUILD .SRCINFO
if git diff --cached --quiet; then echo "В AUR уже $ver"; exit 0; fi
git -c user.name=Bloodrabbid -c user.email=Bloodrabbid@users.noreply.github.com commit -qm "trueconfx-bin $ver"
git push -q origin HEAD:master
echo "Опубликовано в AUR: trueconfx-bin $ver — https://aur.archlinux.org/packages/trueconfx-bin"
