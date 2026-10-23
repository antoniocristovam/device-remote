import React, { useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, Text, TextInput, View } from 'react-native';
import { onRcEvent, rc, shortFingerprint, type PairingEvent } from '../native/rc';
import { colors, radius } from '../theme';
import { Button, Card, styles } from '../components/ui';

const PROGRESS: Partial<Record<PairingEvent['state'], string>> = {
  connecting: 'Conectando ao servidor…',
  waiting: 'Aguardando o computador…',
  completing: 'Finalizando pareamento…',
};

export function PairScreen({ signalingUrl, onDone }: { signalingUrl: string; onDone(): void }) {
  const [ev, setEv] = useState<PairingEvent>();
  const [manual, setManual] = useState(false);
  const [code, setCode] = useState('');
  const [scanError, setScanError] = useState<string>();

  useEffect(() => {
    const off = onRcEvent((e) => {
      if (e.type === 'pairing') setEv(e.payload);
    });
    return () => {
      off();
      rc.cancelPairing();
    };
  }, []);

  const scan = async () => {
    setScanError(undefined);
    try {
      const text = await rc.scanQr();
      if (!text.startsWith('rc1:')) return setScanError('Este QR code não é do Remote Controller.');
      rc.startPairing(text);
    } catch (e: any) {
      if (e?.code !== 'cancelled') setScanError(e?.message ?? 'Falha ao ler o QR code.');
    }
  };

  if (ev?.state === 'confirm') {
    return (
      <ScrollView contentContainerStyle={{ padding: 20 }}>
        <Text style={styles.h1}>Permitir controle remoto?</Text>
        <Card style={{ marginTop: 20 }}>
          <Text style={styles.body}>Computador</Text>
          <Text style={[styles.text, { fontSize: 20, fontWeight: '700', marginTop: 2 }]}>{ev.desktopName}</Text>
          <Text style={[styles.body, { fontFamily: 'monospace', marginTop: 4 }]}>{shortFingerprint(ev.fingerprint)}</Text>
          <View style={{ height: 1, backgroundColor: colors.line, marginVertical: 16 }} />
          <Text style={styles.body}>Confira se o computador mostra o mesmo código:</Text>
          <Text style={{ color: colors.fg, fontFamily: 'monospace', fontSize: 34, letterSpacing: 8, marginTop: 8 }}>
            {ev.sas.slice(0, 3)} {ev.sas.slice(3)}
          </Text>
        </Card>
        <Text style={[styles.body, { marginTop: 16 }]}>
          Ao aceitar, este computador poderá pedir para ver e controlar este aparelho. Cada sessão ainda precisará do seu aceite, e
          você pode revogar o acesso a qualquer momento.
        </Text>
        <Button label="Aceitar e parear" onPress={() => rc.confirmPairing(true)} style={{ marginTop: 20 }} />
        <Button label="Recusar" variant="ghost" onPress={() => rc.confirmPairing(false)} style={{ marginTop: 4 }} />
      </ScrollView>
    );
  }

  if (ev?.state === 'paired') {
    return (
      <View style={{ flex: 1, padding: 20, justifyContent: 'center' }}>
        <Text style={[styles.h1, { color: colors.ok }]}>Pareado</Text>
        <Text style={[styles.body, { marginTop: 8 }]}>
          {ev.peer.name} foi adicionado. Ative “Ficar disponível” quando quiser receber pedidos de conexão.
        </Text>
        <Button label="Concluir" onPress={onDone} style={{ marginTop: 24 }} />
      </View>
    );
  }

  const progress = ev && PROGRESS[ev.state];

  return (
    <ScrollView contentContainerStyle={{ padding: 20 }} keyboardShouldPersistTaps="handled">
      <Text style={styles.h1}>Parear com um computador</Text>
      <Text style={[styles.body, { marginTop: 6 }]}>
        No computador, abra o Remote Controller e clique em “Parear dispositivo”.
      </Text>

      {progress ? (
        <Card style={{ marginTop: 24, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <ActivityIndicator color={colors.accent} />
          <Text style={styles.text}>{progress}</Text>
        </Card>
      ) : (
        <>
          {ev?.state === 'failed' && (
            <Card style={{ marginTop: 20, borderColor: colors.danger }}>
              <Text style={{ color: colors.danger }}>{ev.reason}</Text>
            </Card>
          )}
          {scanError && <Text style={{ color: colors.danger, marginTop: 16 }}>{scanError}</Text>}

          <Button label="Escanear QR code" onPress={scan} style={{ marginTop: 24 }} />

          {manual ? (
            <Card style={{ marginTop: 16 }}>
              <Text style={styles.body}>Código exibido no computador</Text>
              <TextInput
                value={code}
                onChangeText={setCode}
                autoCapitalize="characters"
                autoCorrect={false}
                placeholder="XXXX-XXXX-XXXX-XXXX"
                placeholderTextColor={colors.dim}
                style={{
                  color: colors.fg,
                  fontFamily: 'monospace',
                  fontSize: 18,
                  letterSpacing: 2,
                  borderWidth: 1,
                  borderColor: colors.line,
                  borderRadius: radius.sm,
                  paddingHorizontal: 12,
                  marginTop: 8,
                }}
              />
              {!signalingUrl && (
                <Text style={{ color: colors.warn, marginTop: 8, fontSize: 13 }}>
                  Configure o servidor de sinalização em Ajustes antes de usar o código manual.
                </Text>
              )}
              <Button
                label="Conectar"
                disabled={code.replace(/[\s-]/g, '').length !== 16 || !signalingUrl}
                onPress={() => rc.startPairing(code)}
                style={{ marginTop: 12 }}
              />
            </Card>
          ) : (
            <Button label="Digitar código" variant="secondary" onPress={() => setManual(true)} style={{ marginTop: 10 }} />
          )}
        </>
      )}
      <Button label="Cancelar" variant="ghost" onPress={onDone} style={{ marginTop: 12 }} />
    </ScrollView>
  );
}
