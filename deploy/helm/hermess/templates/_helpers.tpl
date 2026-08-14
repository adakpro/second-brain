{{- define "hermess.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "hermess.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name (include "hermess.name" .) | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}

{{- define "hermess.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
app.kubernetes.io/name: {{ include "hermess.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "hermess.selectorLabels" -}}
app.kubernetes.io/name: {{ include "hermess.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "hermess.secretName" -}}
{{- if .Values.secrets.create -}}
{{ include "hermess.fullname" . }}-secrets
{{- else -}}
{{ required "secrets.existingSecret is required when secrets.create=false" .Values.secrets.existingSecret }}
{{- end -}}
{{- end }}

{{- define "hermess.image" -}}
{{- if .digest -}}
{{- printf "%s:%s@%s" .repository (.tag | default "latest") .digest -}}
{{- else -}}
{{- printf "%s:%s" .repository (.tag | default "latest") -}}
{{- end -}}
{{- end }}
