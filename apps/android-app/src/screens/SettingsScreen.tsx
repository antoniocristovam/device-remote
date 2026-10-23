import React, { useState } from 'react';
import { ScrollView, Text, TextInput } from 'react-native';
import { rc, shortFingerprint, type RcState } from '../native/rc';
import { colors, radius } from '../theme';
import { Button, Card, SectionTitle, styles } from '../components/ui';

const input = {
  color: colors.fg,
  borderWidth: 1,
  borderColor: colors.line,
  borderRadius: radius.sm,
  paddingHorizontal: 12,
  marginTop: 6,
  fontSize: 15,
};

export function SettingsScreen({ state }: { state: RcState }) {
  const [name, setName] = useState(state.settings.deviceName);
  const [url, setUrl] = useState(state.settings.signalingUrl);
  const [saved, setSaved] = useState(false);
  const urlValid = url === '' || /^wss?:\/\/.+/.test(url);

  return (
    <ScrollView contentContainerStyle={{ padding: 20 }} keyboardShouldPersistTaps="handled">
      <Text style={styles.h1}>Ajustes</Text>
      <Card style={{ marginTop: 20 }}>
        <Text style={styles.body}>Nome deste aparelho</Text>
        <TextInput value={name} onChangeText={setName} style={input} placeholderTextColor={colors.dim} />
        <Text style={[styles.body, { marginTop: 16 }]}>Servidor de sinalização</Text>
        <TextInput
          value={url}
          onChangeText={setUrl}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="wss://sinalizacao.exemplo.com"
          placeholderTextColor={colors.dim}
          style={[input, { fontFamily: 'monospace', borderColor: urlValid ? colors.line : colors.danger }]}
        />
        <Text style={{ color: colors.dim, fontSize: 12, marginTop: 6 }}>Preenchido automaticamente ao escanear o QR code.</Text>
        <Button
          label={saved ? 'Salvo' : 'Salvar'}
          disabled={!urlValid}
          onPress={() => {
            rc.saveSettings({ deviceName: name, signalingUrl: url });
            setSaved(true);
            setTimeout(() => setSaved(false), 1500);
          }}
          style={{ marginTop: 16 }}
        />
      </Card>

      <SectionTitle>Identidade</SectionTitle>
      <Card>
        <Text style={styles.body}>Impressão digital da chave deste aparelho (Android Keystore)</Text>
        <Text style={[styles.text, { fontFamily: 'monospace', marginTop: 6 }]}>{shortFingerprint(state.identity.fingerprint)}</Text>
      </Card>
    </ScrollView>
  );
}
