import { createApp } from 'vue'
import App from './App.vue'
import './style.css'
import { smokeStage } from './smoke'
smokeStage('main-entry', 'Vue entry module loaded')
createApp(App).mount('#app')
