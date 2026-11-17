package dev.agaminggod.mineagen.client.camera;

/** Interpolated camera pose returned by a path sample. */
public record CameraPose(double x, double y, double z, float yaw, float pitch) {
}
