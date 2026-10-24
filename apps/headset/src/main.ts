import './styles.css';
import { boot } from './app/boot';

const root = document.getElementById('app');
if (root) void boot(root);
