import { useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import QRCode from 'qrcode';
import { CheckCircle2, RefreshCw, ShieldCheck, XCircle } from 'lucide-react';
import { rc } from '../rc';
import type { PairingEvent } from '../../../shared/api';
import { duration } from '../lib/format';

export function PairingView({ online, onPaired }: { online: boolean; onPaired(fp: string): void }) {
  const [ev, setEv] = useState<PairingEvent>();
  const [code, setCode] = useState<{ code: string; qr: string; expiresAt: number }>();
  const [qrImg, setQrImg] = useState<string>();
  const [now, setNow] = useState(Date.now());
  const onPairedRef = useRef(onPaired);
  onPairedRef.current = onPaired;

  useEffect(() => {
    const off = rc.pairing.on((e) => {
      setEv(e);
      if (e.state === 'waiting') setCode(e);
      if (e.state === 'paired') setTimeout(() => onPairedRef.current(e.peer.fingerprint), 900);
    });
    void rc.pairing.start();
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => {
      off();
      clearInterval(t);
      void rc.pairing.cancel();
    };
  }, []);

  useEffect(() => {
    if (!code) return;
    void QRCode.toDataURL(code.qr, { margin: 1, width: 440, color: { dark: '#0b0b0f', light: '#ffffff' }, errorCorrectionLevel: 'M' }).then(setQrImg);
  }, [code]);

  const restart = () => {
    setEv(undefined);
    setQrImg(undefined);
    void rc.pairing.start();
  };

  return (
    <div className="flex h-full items-center justify-center p-10">
      <div className="grid w-full max-w-3xl grid-cols-[auto_1fr] items-center gap-12">
        <div className="relative">
          <div className={`rounded-2xl bg-white p-3 shadow-2xl shadow-accent/10 transition ${ev?.state === 'waiting' ? '' : 'opacity-20 blur-[2px]'}`}>
            {qrImg ? <img src={qrImg} alt="QR code de pareamento" className="size-56" /> : <div className="size-56" />}
          </div>
          {ev?.state === 'paired' && (
            <motion.div initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} className="absolute inset-0 grid place-items-center">
              <CheckCircle2 size={72} className="text-ok" />
            </motion.div>
          )}
        </div>

        <div className="space-y-6">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Parear um celular</h1>
            <p className="mt-1.5 max-w-sm leading-relaxed text-muted">
              Abra o Remote Controller no Android e escaneie o código, ou digite-o manualmente. Nada é conectado até você aceitar no
              celular.
            </p>
          </div>

          {!online && <p className="rounded-md border border-warn/30 bg-warn/10 px-3 py-2 text-warn">Sem conexão com o servidor de sinalização.</p>}

          {ev?.state === 'waiting' && code && (
            <div className="space-y-2">
              <div className="font-mono text-2xl tracking-[0.18em] text-fg select-text">{code.code}</div>
              <div className="text-muted">Expira em {duration(code.expiresAt - now)}</div>
            </div>
          )}

          {ev?.state === 'confirm' && (
            <motion.div initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} className="space-y-2 rounded-lg border border-accent/40 bg-accent/10 p-4">
              <div className="flex items-center gap-2 font-medium">
                <ShieldCheck size={16} className="text-accent" /> Confirme no celular
              </div>
              <p className="text-muted">O celular deve exibir o mesmo código de verificação:</p>
              <div className="font-mono text-3xl tracking-[0.3em]">
                {ev.sas.slice(0, 3)} {ev.sas.slice(3)}
              </div>
            </motion.div>
          )}

          {ev?.state === 'paired' && <p className="text-ok">Pareado com {ev.peer.name}.</p>}

          {(ev?.state === 'failed' || ev?.state === 'expired') && (
            <div className="space-y-3">
              <p className="flex items-center gap-2 text-danger">
                <XCircle size={16} /> {ev.state === 'failed' ? ev.reason : 'O código expirou.'}
              </p>
              <button onClick={restart} className="flex items-center gap-2 rounded-md bg-accent px-3 py-1.5 font-medium text-white hover:bg-accent-strong">
                <RefreshCw size={14} /> Gerar novo código
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
