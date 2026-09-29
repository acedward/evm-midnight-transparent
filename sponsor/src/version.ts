// The sponsor's reported version: the build's commit when the image sets SPONSOR_VERSION, else a dev tag.
export const SPONSOR_VERSION: string = process.env.SPONSOR_VERSION?.trim() || '0.1.0-dev';
