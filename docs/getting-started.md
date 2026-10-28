# Getting Started: Initial Configuration

To use the exhibition catalog tools, you must configure credentials for the services used in the pipeline.

## 1. Credentials Configuration

Run the following MCP tools in your session:

1. **Weeek API:**
   ```javascript
   // Get your token: Weeek Settings → Integrations → API
   weeek_set_token({ token: "<YOUR_WEEEK_TOKEN>" })
   ```

2. **DaData API:**
   ```javascript
   // Get token/secret: dadata.ru → Profile → API keys
   inn_set_dadata_token({ token: "<YOUR_TOKEN>", secret: "<YOUR_SECRET>" })
   ```

3. **Checko API:**
   ```javascript
   // Get key: checko.ru → Profile
   inn_set_checko_key({ key: "<YOUR_CHECKO_KEY>" })
   ```

## 2. Setting Active Exhibition
Before running pipeline tools, set the active exhibition:
```javascript
flexi_set_active_exhibition({ event_key: "<key>", name: "<Title>" })
```
This saves the context in `contexts/flexi/active_exhibition.json`.
