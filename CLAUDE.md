# Repository instructions

Read [README.md](README.md) and the original tool contract/source. Keep names stable unless a versioned compatibility change is accepted. Every provider request has a timeout and declared mutation scope; credentials are host-owned and never logged. Test with offline fixtures before a scoped live canary.

Документы содержат действующие требования, контракты и инструкции. Планы выполнения, статусы, ревью прошлых версий и evidence ведутся в GitHub issues/PR/Project. Целевая модель не является утверждением о текущем deployment; его готовность проверяется по конкретным SHA и приёмке.

Retiring GCP VM is not a development or fallback target. Use the own Agent Run API and serverless by default; a necessary persistent service belongs on the existing French VM. Other Google services remain allowed. Exit coordination: https://github.com/trained-assist/trained-agent-architecture/issues/145.
