/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

// The <model-viewer> web component is loaded from a CDN in app.html (see the
// 3D Viewer → Image capture screen). Declare the element + the methods we call.
interface ModelViewerElement extends HTMLElement {
  toDataURL(type?: string, quality?: number): string;
  toBlob(options?: { mimeType?: string; qualityArgument?: number }): Promise<Blob>;
  // Animation API (for rigged characters).
  readonly availableAnimations: string[];
  animationName?: string;
  currentTime: number;
  readonly duration: number;
  readonly paused: boolean;
  timeScale: number;
  play(options?: { repetitions?: number; pingpong?: boolean }): void;
  pause(): void;
}

declare namespace JSX {
  interface IntrinsicElements {
    'model-viewer': React.DetailedHTMLProps<React.HTMLAttributes<ModelViewerElement>, ModelViewerElement> & {
      src?: string;
      alt?: string;
      'camera-controls'?: boolean;
      'auto-rotate'?: boolean;
      autoplay?: boolean;
      'animation-name'?: string;
      'shadow-intensity'?: string;
      exposure?: string;
      'environment-image'?: string;
      'touch-action'?: string;
    };
  }
}
