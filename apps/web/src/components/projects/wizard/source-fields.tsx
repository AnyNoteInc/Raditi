'use client'

import Box from '@mui/material/Box'
import FormControl from '@mui/material/FormControl'
import FormControlLabel from '@mui/material/FormControlLabel'
import FormLabel from '@mui/material/FormLabel'
import Radio from '@mui/material/Radio'
import RadioGroup from '@mui/material/RadioGroup'
import Tab from '@mui/material/Tab'
import Tabs from '@mui/material/Tabs'
import Typography from '@mui/material/Typography'
import { fontFamilies } from '@repo/ui/theme/tokens'
import type { ReactNode } from 'react'

import { AppIcon } from '@/components/application/app-icon'

import { AccessField, PortField, TlsField } from './fields'
import type { FieldErrors, SourceDraft, SourceField, SourceKind } from './wizard-model'

const tabs: readonly { kind: SourceKind; label: string; icon: 'terminal' | 'folder' }[] = [
  { kind: 'sftp', label: 'SSH', icon: 'terminal' },
  { kind: 'ftp', label: 'FTP', icon: 'folder' },
]

const tabNotes: Record<SourceKind, string> = {
  sftp: 'Подключение по SSH надёжнее всего. Данные для входа обычно есть в панели хостинга, в разделе SSH или SFTP.',
  ftp: 'Если SSH у хостинга нет, подойдёт FTP — лучше с шифрованием FTPS.',
}

/**
 * The third way of the wizard (docs/plan/57-browser-tasks.md, Б8): no access to the files at all
 * — the agent works in the site's admin pages through the browser. Its panel is the wizard's.
 */
export interface BrowserAccessOption {
  selected: boolean
  onSelect: (selected: boolean) => void
  panel: ReactNode
}

const BROWSER_TAB = 'browser'

/** The id of a field of the form; the wizard moves the focus to it by this id. */
export const sourceFieldId = (prefix: string, field: SourceField) => `${prefix}-${field}`

/**
 * «Доступ к файлам»: SSH and FTP on two tabs, each keeping what was typed in it. Only fields:
 * the check, the host key and what the server answered belong to the form that holds it.
 */
export function SourceFields({
  idPrefix,
  value,
  onChange,
  errors,
  disabled,
  browser,
}: {
  idPrefix: string
  value: SourceDraft
  onChange: (next: SourceDraft) => void
  errors: FieldErrors<SourceField>
  disabled: boolean
  /** Offered by the wizard of a new project only: «Изменить доступ» keeps the two tabs. */
  browser?: BrowserAccessOption
}) {
  const id = (field: SourceField) => sourceFieldId(idPrefix, field)
  const tabId = (kind: SourceKind | typeof BROWSER_TAB) => `${idPrefix}-tab-${kind}`
  const panelId = `${idPrefix}-panel`
  const ssh = value.sftp
  const ftp = value.ftp
  const setSsh = (patch: Partial<SourceDraft['sftp']>) =>
    onChange({ ...value, sftp: { ...ssh, ...patch } })
  const setFtp = (patch: Partial<SourceDraft['ftp']>) =>
    onChange({ ...value, ftp: { ...ftp, ...patch } })
  const fields = value.kind === 'ftp' ? ftp : ssh
  const set = value.kind === 'ftp' ? setFtp : setSsh

  return (
    <Box>
      <Tabs
        value={browser?.selected ? BROWSER_TAB : value.kind}
        onChange={(_event, kind: SourceKind | typeof BROWSER_TAB) => {
          if (kind === BROWSER_TAB) return browser?.onSelect(true)
          browser?.onSelect(false)
          onChange({ ...value, kind })
        }}
        aria-label="Способ доступа к файлам"
        variant="fullWidth"
        sx={{
          minHeight: 52,
          borderBottom: 1,
          borderColor: 'divider',
          '& .MuiTab-root': { minHeight: 52, fontSize: 15, fontWeight: 600, gap: 1 },
        }}
      >
        {tabs.map((tab) => (
          <Tab
            key={tab.kind}
            value={tab.kind}
            id={tabId(tab.kind)}
            aria-controls={panelId}
            label={tab.label}
            icon={<AppIcon name={tab.icon} size={20} />}
            iconPosition="start"
            disabled={disabled}
          />
        ))}
        {browser ? (
          <Tab
            value={BROWSER_TAB}
            id={tabId(BROWSER_TAB)}
            aria-controls={panelId}
            // The visible words are the start of the name (WCAG 2.5.3).
            aria-label="Без доступа к файлам"
            label="Без доступа"
            icon={<AppIcon name="globe" size={20} />}
            iconPosition="start"
            disabled={disabled}
          />
        ) : null}
      </Tabs>
      {browser?.selected ? (
        <Box
          role="tabpanel"
          id={panelId}
          aria-labelledby={tabId(BROWSER_TAB)}
          sx={{ pt: 2.5, display: 'flex', flexDirection: 'column', gap: 2.5 }}
        >
          {browser.panel}
        </Box>
      ) : (
        <Box
          role="tabpanel"
          id={panelId}
          aria-labelledby={tabId(value.kind)}
          sx={{ pt: 2.5, display: 'flex', flexDirection: 'column', gap: 2.5 }}
        >
          <Typography variant="body2" color="text.secondary" sx={{ textWrap: 'pretty' }}>
            {tabNotes[value.kind]}
          </Typography>
          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: { xs: 'minmax(0, 1fr)', sm: 'minmax(0, 1fr) 132px' },
              gap: 2.5,
            }}
          >
            <AccessField
              id={id('host')}
              label="Сервер"
              code
              required
              value={fields.host}
              onChange={(event) => set({ host: event.target.value })}
              disabled={disabled}
              error={errors.host}
              helperText={
                value.kind === 'ftp'
                  ? 'Адрес FTP-сервера, например ftp.example.ru'
                  : 'Адрес SSH-сервера, например ssh.example.ru'
              }
              slotProps={{ htmlInput: { maxLength: 253, inputMode: 'url' } }}
            />
            <PortField
              id={id('port')}
              value={fields.port}
              onChange={(event) => set({ port: event.target.value })}
              disabled={disabled}
              error={errors.port}
            />
          </Box>
          <AccessField
            id={id('username')}
            label="Пользователь"
            code
            required
            value={fields.username}
            onChange={(event) => set({ username: event.target.value })}
            disabled={disabled}
            error={errors.username}
            slotProps={{ htmlInput: { maxLength: 128 } }}
          />
          {value.kind === 'sftp' ? (
            <FormControl component="fieldset" disabled={disabled} sx={{ m: 0, minWidth: 0 }}>
              <FormLabel component="legend" sx={{ fontSize: 14, mb: 0.5 }}>
                Способ входа
              </FormLabel>
              <RadioGroup
                row
                name={`${idPrefix}-method`}
                value={ssh.method}
                onChange={(_event, method) => setSsh({ method: method as 'password' | 'key' })}
                sx={{ gap: 1 }}
              >
                <FormControlLabel
                  value="password"
                  control={<Radio />}
                  label="Пароль"
                  sx={{ minHeight: 44, mr: 2 }}
                />
                <FormControlLabel
                  value="key"
                  control={<Radio />}
                  label="Ключ"
                  sx={{ minHeight: 44 }}
                />
              </RadioGroup>
            </FormControl>
          ) : null}
          {value.kind === 'sftp' && ssh.method === 'key' ? (
            <>
              <AccessField
                id={id('privateKey')}
                label="Приватный ключ"
                secret
                required
                multiline
                minRows={5}
                maxRows={12}
                value={ssh.privateKey}
                onChange={(event) => setSsh({ privateKey: event.target.value })}
                disabled={disabled}
                error={errors.privateKey}
                helperText="Вставьте ключ целиком, вместе с первой и последней строкой. Мы сохраним его в защищённом хранилище и больше не покажем."
                slotProps={{
                  htmlInput: {
                    // A key is long and has no spaces: it wraps anywhere, in a fixed-width face.
                    style: {
                      fontFamily: fontFamilies.mono,
                      fontSize: 13,
                      lineHeight: 1.5,
                      wordBreak: 'break-all',
                    },
                  },
                }}
              />
              <AccessField
                id={`${idPrefix}-passphrase`}
                label="Парольная фраза ключа (если есть)"
                secret
                type="password"
                value={ssh.passphrase}
                onChange={(event) => setSsh({ passphrase: event.target.value })}
                disabled={disabled}
                helperText="Оставьте пустым, если ключ без парольной фразы."
              />
            </>
          ) : (
            <AccessField
              id={id('password')}
              label="Пароль"
              secret
              required
              type="password"
              value={fields.password}
              onChange={(event) => set({ password: event.target.value })}
              disabled={disabled}
              error={errors.password}
              helperText="Мы сохраним пароль в защищённом хранилище и больше не покажем."
            />
          )}
          <AccessField
            id={id('rootPath')}
            label="Папка сайта на сервере"
            code
            required
            value={fields.rootPath}
            onChange={(event) => set({ rootPath: event.target.value })}
            disabled={disabled}
            error={errors.rootPath}
            helperText="Папка, где лежат файлы сайта, например /var/www/example.ru/public_html"
            slotProps={{ htmlInput: { maxLength: 1024 } }}
          />
          {value.kind === 'ftp' ? (
            <TlsField
              id={`${idPrefix}-tls`}
              of="file"
              value={ftp.tls}
              onChange={(tls) => setFtp({ tls })}
              disabled={disabled}
            />
          ) : null}
        </Box>
      )}
    </Box>
  )
}
