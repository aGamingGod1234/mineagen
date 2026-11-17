package dev.agaminggod.mineagen.server;

import com.sun.jna.platform.win32.Crypt32Util;
import com.sun.jna.platform.win32.WinCrypt;

/**
 * Encrypts to the current Windows user with DPAPI (CryptProtectData). JNA and jna-platform ship with Minecraft
 * 26.x on both the client and the dedicated server, so this adds no dependency. Loaded only on Windows.
 */
final class WindowsDpapiKeyProtector implements ProviderKeyProtector {
	@Override public String scheme() { return "dpapi"; }

	@Override public byte[] protect(byte[] plain) {
		return Crypt32Util.cryptProtectData(plain, WinCrypt.CRYPTPROTECT_UI_FORBIDDEN);
	}

	@Override public byte[] unprotect(byte[] sealed) {
		return Crypt32Util.cryptUnprotectData(sealed, WinCrypt.CRYPTPROTECT_UI_FORBIDDEN);
	}

	@Override public String toString() { return "WindowsDpapiKeyProtector"; }
}
