import { useEffect, useRef, useState } from 'react';

/**
 * Barcode scanning via the browser's own `BarcodeDetector`.
 *
 * No library: Chrome on Android ships this natively, which is the target here.
 * Everywhere else it is absent, so the whole feature is behind a capability check
 * and the manual path stays fully usable — scanning is a shortcut, never the only
 * way in.
 *
 * WHAT A BARCODE CAN AND CANNOT DO, since this is easy to be disappointed by: it
 * carries a product identifier and nothing else. Not a name, and definitely not a
 * price. Turning one into a product name needs a database and a network
 * connection, and this app has to work in a shop with neither.
 *
 * So the payoff is memory rather than lookup. Tell it once that this barcode is
 * "oat milk, $4.29", and every later scan fills itself in instantly and offline.
 * The first scan of anything still needs typing.
 */

export function isScanningSupported(): boolean {
  return typeof window !== 'undefined' && 'BarcodeDetector' in window;
}

type ScannerState = 'starting' | 'scanning' | 'denied' | 'unavailable' | 'error';

/** Formats worth detecting. Retail packaging is EAN/UPC; the rest are noise. */
const FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39'];

interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<Array<{ rawValue: string }>>;
}

export function BarcodeScanner({
  onDetected,
  onCancel,
}: {
  onDetected: (barcode: string) => void;
  onCancel: () => void;
}): JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [state, setState] = useState<ScannerState>('starting');
  const [detail, setDetail] = useState<string | null>(null);

  useEffect(() => {
    if (!isScanningSupported()) {
      setState('unavailable');
      return;
    }

    let stream: MediaStream | null = null;
    let frame = 0;
    let stopped = false;

    async function start(): Promise<void> {
      try {
        // The rear camera is the one pointed at a shelf.
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' } },
        });
        if (stopped) return;

        const video = videoRef.current;
        if (!video) return;
        video.srcObject = stream;
        await video.play();
        setState('scanning');

        const Detector = (window as unknown as { BarcodeDetector: new (o: unknown) => BarcodeDetectorLike })
          .BarcodeDetector;
        const detector = new Detector({ formats: FORMATS });

        const scan = async (): Promise<void> => {
          if (stopped || !videoRef.current) return;
          try {
            const found = await detector.detect(videoRef.current);
            if (found.length > 0 && found[0].rawValue) {
              // Haptic confirmation matters here: you are looking at a shelf, not
              // at the screen, and this is the signal that you can move on.
              navigator.vibrate?.(60);
              onDetected(found[0].rawValue);
              return;
            }
          } catch {
            // Individual frames fail routinely while focusing. Not worth surfacing.
          }
          frame = requestAnimationFrame(() => void scan());
        };

        frame = requestAnimationFrame(() => void scan());
      } catch (err) {
        if (stopped) return;
        const name = err instanceof Error ? err.name : '';
        if (name === 'NotAllowedError' || name === 'SecurityError') setState('denied');
        else {
          setState('error');
          setDetail(err instanceof Error ? err.message : String(err));
        }
      }
    }

    void start();

    return () => {
      stopped = true;
      cancelAnimationFrame(frame);
      // Releasing every track is what turns the camera light off. Leaving a
      // stream open after the sheet closes looks, reasonably, like spying.
      stream?.getTracks().forEach((track) => track.stop());
    };
  }, [onDetected]);

  if (state === 'unavailable') {
    return (
      <div className="card small dim">
        This browser cannot scan barcodes. Chrome on Android can; otherwise type
        the item in below — it works the same, just with more typing.
        <button className="btn small block" style={{ marginTop: 10 }} onClick={onCancel}>
          Enter it manually
        </button>
      </div>
    );
  }

  if (state === 'denied') {
    return (
      <div className="card small dim">
        Camera access was declined. You can allow it in your browser's site
        settings, or just type the item in.
        <button className="btn small block" style={{ marginTop: 10 }} onClick={onCancel}>
          Enter it manually
        </button>
      </div>
    );
  }

  return (
    <div>
      <div className="scanner">
        <video ref={videoRef} playsInline muted />
        <div className="scanner-reticle" />
        {state === 'starting' && (
          <div className="scanner-hint"><div className="spinner" /></div>
        )}
      </div>

      <p className="tiny faint" style={{ textAlign: 'center', marginTop: 8 }}>
        {state === 'scanning'
          ? 'Point at the barcode. Scanning only names the item — you still enter the price.'
          : 'Starting the camera…'}
      </p>

      {detail && <p className="tiny" style={{ color: 'var(--danger)' }}>{detail}</p>}

      <button className="btn block" onClick={onCancel}>Cancel</button>
    </div>
  );
}
