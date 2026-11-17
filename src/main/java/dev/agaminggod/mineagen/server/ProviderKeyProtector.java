package dev.agaminggod.mineagen.server;

/**
 * Encrypts a saved provider API key at rest. Implementations must never put the key in an exception, log or
 * {@code toString}; callers treat any thrown {@link RuntimeException} or {@link LinkageError} as "not protected".
 */
interface ProviderKeyProtector {
	/** Stored in the file header, so a key protected one way is never handed to another scheme. */
	String scheme();
	byte[] protect(byte[] plain);
	byte[] unprotect(byte[] sealed);

	/** DPAPI on Windows; null elsewhere, where the owner-only file is the protection the platform offers. */
	static ProviderKeyProtector platformDefault() {
		return System.getProperty("os.name", "").startsWith("Windows") ? new WindowsDpapiKeyProtector() : null;
	}
}
