// On suppose que PDFLib est disponible en global (PDFLib)
document.addEventListener('DOMContentLoaded', () => {
    const form = document.getElementById('pdf-form');
    const pdfInput = document.getElementById('pdf-upload');
    const expiryInput = document.getElementById('expiry-date');
    const messageDiv = document.getElementById('message');
    const downloadDiv = document.getElementById('download-link');

    // Ajout d'un spinner animé pour le feedback utilisateur
    function showSpinner(target, message) {
        target.innerHTML = `<span class="spinner"></span> ${message || ''}`;
        target.classList.remove('success', 'error');
        target.style.display = 'block';
    }
    function showSuccess(target, message) {
        target.textContent = message;
        target.classList.remove('error');
        target.classList.add('success');
        target.style.display = 'block';
        playSound('success');
        confettiBurst();
    }
    function showError(target, message) {
        target.textContent = message;
        target.classList.remove('success');
        target.classList.add('error');
        target.style.display = 'block';
        playSound('error');
    }
    function hideFeedback(target) {
        target.textContent = '';
        target.classList.remove('success', 'error');
        target.style.display = 'none';
    }
    function animateDownloadLink(linkDiv) {
        linkDiv.style.display = 'block';
        linkDiv.classList.add('pop-download');
        setTimeout(() => linkDiv.classList.remove('pop-download'), 1200);
    }

    // Fonction utilitaire pour dériver une clé à partir de la date
    async function deriveKey(dateStr) {
        const enc = new TextEncoder();
        const keyMaterial = await window.crypto.subtle.importKey(
            'raw',
            enc.encode(dateStr),
            { name: 'PBKDF2' },
            false,
            ['deriveKey']
        );
        return window.crypto.subtle.deriveKey(
            {
                name: 'PBKDF2',
                salt: enc.encode('pdf-autodestruct'),
                iterations: 100000,
                hash: 'SHA-256'
            },
            keyMaterial,
            { name: 'AES-GCM', length: 256 },
            false,
            ['encrypt', 'decrypt']
        );
    }

    // Fonction de chiffrement
    async function encryptContent(contentUint8, dateStr) {
        const key = await deriveKey(dateStr);
        const iv = window.crypto.getRandomValues(new Uint8Array(12));
        const encrypted = await window.crypto.subtle.encrypt(
            { name: 'AES-GCM', iv },
            key,
            contentUint8
        );
        // On retourne IV + données chiffrées (pour pouvoir déchiffrer plus tard)
        const encryptedArray = new Uint8Array(iv.length + encrypted.byteLength);
        encryptedArray.set(iv, 0);
        encryptedArray.set(new Uint8Array(encrypted), iv.length);
        return encryptedArray;
    }

    function uint8ToBase64(uint8) {
        let binary = '';
        const chunkSize = 0x8000; // 32k
        for (let i = 0; i < uint8.length; i += chunkSize) {
            binary += String.fromCharCode.apply(null, uint8.subarray(i, i + chunkSize));
        }
        return btoa(binary);
    }

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        hideFeedback(messageDiv);
        downloadDiv.style.display = 'none';
        downloadDiv.innerHTML = '';

        const file = pdfInput.files[0];
        const expiry = expiryInput.value;

        if (!file) {
            showError(messageDiv, 'Veuillez sélectionner un fichier PDF.');
            return;
        }
        if (!expiry) {
            showError(messageDiv, 'Veuillez choisir une date/heure limite.');
            return;
        }

        showSpinner(messageDiv, 'Lecture et chiffrement du PDF...');

        try {
            const arrayBuffer = await file.arrayBuffer();
            const uint8 = new Uint8Array(arrayBuffer);
            // Chiffrement du contenu PDF
            const encrypted = await encryptContent(uint8, expiry);

            // Création d'un nouveau PDF avec PDF-lib
            const pdfDoc = await PDFLib.PDFDocument.create();
            const page1 = pdfDoc.addPage([595, 842]); // A4
            const font = await pdfDoc.embedFont(PDFLib.StandardFonts.Helvetica);
            const warning =
                'Ce PDF est protégé.\n' +
                'Le contenu original est chiffré et ne peut être déchiffré que via l\'application web PDF Autodestruct.\n' +
                'Date limite : ' + expiry.replace('T', ' ') + '\n' +
                'Après cette date, le contenu ne sera plus accessible.';
            page1.drawText(warning, {
                x: 40,
                y: 700,
                size: 14,
                font,
                color: PDFLib.rgb(0.8, 0.1, 0.1),
                maxWidth: 500
            });

            // On encode le contenu chiffré en base64 pour l'inclure dans une deuxième page
            const b64 = uint8ToBase64(encrypted);
            const lines = b64.match(/.{1,100}/g) || [];
            const linesPerPage = 75; // 75 lignes de 100 caractères ≈ 7500 caractères/page
            let pageIdx = 1;
            for (let i = 0; i < lines.length; i += linesPerPage) {
                const page = pdfDoc.addPage([595, 842]);
                const monoFont = await pdfDoc.embedFont(PDFLib.StandardFonts.Courier);
                let y = 800;
                for (let j = i; j < i + linesPerPage && j < lines.length; j++) {
                    page.drawText(lines[j], {
                        x: 40,
                        y: y,
                        size: 8,
                        font: monoFont,
                        color: PDFLib.rgb(0,0,0)
                    });
                    y -= 10;
                }
                pageIdx++;
            }

            const pdfBytes = await pdfDoc.save();
            const blob = new Blob([pdfBytes], { type: 'application/pdf' });
            const url = URL.createObjectURL(blob);
            downloadDiv.innerHTML = `<a href="${url}" download="pdf-protege.pdf" class="animated-download">Télécharger le PDF protégé</a>`;
            animateDownloadLink(downloadDiv);
            showSuccess(messageDiv, 'PDF protégé généré avec succès !');
            console.log('Longueur base64 généré:', b64.length);
        } catch (err) {
            showError(messageDiv, 'Erreur lors du traitement : ' + err.message);
        }
    });

    // Fonction de déchiffrement
    async function decryptContent(encryptedUint8, dateStr) {
        const key = await deriveKey(dateStr);
        const iv = encryptedUint8.slice(0, 12);
        const data = encryptedUint8.slice(12);
        const decrypted = await window.crypto.subtle.decrypt(
            { name: 'AES-GCM', iv },
            key,
            data
        );
        return new Uint8Array(decrypted);
    }

    // Fonction utilitaire pour convertir base64 -> Uint8Array (sans stack overflow)
    function base64ToUint8(b64) {
        // Nettoyer la chaîne (enlever les espaces, retours à la ligne)
        b64 = b64.replace(/\s+/g, '');
        const bytes = [];
        const chunkSize = 16384 * 4; // multiple de 4
        for (let i = 0; i < b64.length; i += chunkSize) {
            const chunk = b64.slice(i, i + chunkSize);
            const bin = atob(chunk);
            for (let j = 0; j < bin.length; j++) {
                bytes.push(bin.charCodeAt(j));
            }
        }
        return new Uint8Array(bytes);
    }

    // Ajout de la logique de déchiffrement
    const decryptForm = document.getElementById('decrypt-form');
    const protectedInput = document.getElementById('protected-upload');
    const decryptDateInput = document.getElementById('decrypt-date');
    const decryptMessage = document.getElementById('decrypt-message');
    const decryptDownload = document.getElementById('decrypt-download');

    decryptForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        hideFeedback(decryptMessage);
        decryptDownload.style.display = 'none';
        decryptDownload.innerHTML = '';

        const file = protectedInput.files[0];
        const date = decryptDateInput.value;
        if (!file) {
            showError(decryptMessage, 'Veuillez sélectionner un PDF protégé.');
            return;
        }
        if (!date) {
            showError(decryptMessage, 'Veuillez saisir la date/heure limite utilisée à la création.');
            return;
        }

        showSpinner(decryptMessage, 'Lecture et extraction du contenu chiffré...');
        try {
            const arrayBuffer = await file.arrayBuffer();

            // Utilisation de PDF.js pour extraire le texte de la page 2+
            const loadingTask = window.pdfjsLib.getDocument({data: arrayBuffer});
            const pdf = await loadingTask.promise;
            if (pdf.numPages < 2) {
                showError(decryptMessage, 'PDF protégé invalide (pas de page de données).');
                return;
            }
            let base64str = '';
            for (let p = 2; p <= pdf.numPages; p++) {
                const page = await pdf.getPage(p);
                const textContent = await page.getTextContent();
                base64str += textContent.items.map(item => item.str).join('');
            }
            base64str = base64str.replace(/\s+/g, '');
            while (base64str.length % 4 !== 0) {
                base64str += '=';
            }
            if (!base64str || base64str.length < 100) {
                showError(decryptMessage, 'Impossible de lire le contenu chiffré (pages 2+).');
                return;
            }
            console.log('Longueur base64 extrait:', base64str.length);
            console.log('Début:', base64str.slice(0, 100));
            console.log('Fin:', base64str.slice(-100));
            showSpinner(decryptMessage, 'Déchiffrement en cours...');
            const encrypted = base64ToUint8(base64str);
            const decrypted = await decryptContent(encrypted, date);
            // On propose le téléchargement du PDF original
            const blob = new Blob([decrypted], { type: 'application/pdf' });
            const url = URL.createObjectURL(blob);
            decryptDownload.innerHTML = `<a href="${url}" download="pdf-original.pdf" class="animated-download">Télécharger le PDF original</a>`;
            animateDownloadLink(decryptDownload);
            showSuccess(decryptMessage, 'Déchiffrement réussi !');
        } catch (err) {
            showError(decryptMessage, 'Erreur lors du déchiffrement : ' + (err && err.message ? err.message : err));
        }
    });

    // Focus automatique sur le premier champ du formulaire à l'ouverture
    setTimeout(() => {
        if (pdfInput) pdfInput.focus();
    }, 300);

    // Micro-interaction drag & drop sur les zones de drop
    function setupDropArea(areaSelector, inputSelector) {
        const area = document.querySelector(areaSelector);
        const input = document.querySelector(inputSelector);
        if (!area || !input) return;
        area.addEventListener('dragover', e => {
            e.preventDefault();
            area.classList.add('is-active');
        });
        area.addEventListener('dragleave', e => {
            area.classList.remove('is-active');
        });
        area.addEventListener('drop', e => {
            e.preventDefault();
            area.classList.remove('is-active');
            if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
                input.files = e.dataTransfer.files;
                input.dispatchEvent(new Event('change'));
            }
        });
        area.addEventListener('click', () => input.click());
        input.addEventListener('focus', () => area.classList.add('is-active'));
        input.addEventListener('blur', () => area.classList.remove('is-active'));
    }
    setupDropArea('.card-create .file-drop-area', '#pdf-upload');
    setupDropArea('.card-decrypt .file-drop-area', '#protected-upload');

    // Feedback sonore (succès/erreur)
    function playSound(type) {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.connect(g); g.connect(ctx.destination);
        o.type = 'triangle';
        if (type === 'success') {
            o.frequency.value = 880;
            g.gain.value = 0.08;
        } else {
            o.frequency.value = 220;
            g.gain.value = 0.12;
        }
        o.start();
        setTimeout(() => { g.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.15); o.stop(ctx.currentTime + 0.15); }, 180);
    }

    // Confetti effet lors d'un succès (canvas-confetti minimal)
    function confettiBurst() {
        const c = document.createElement('canvas');
        c.style.position = 'fixed';
        c.style.left = 0; c.style.top = 0;
        c.style.width = '100vw'; c.style.height = '100vh';
        c.style.pointerEvents = 'none';
        c.width = window.innerWidth; c.height = window.innerHeight;
        document.body.appendChild(c);
        const ctx = c.getContext('2d');
        const colors = ['#4f46e5','#059669','#f59e42','#e11d48','#10b981'];
        const pieces = Array.from({length: 42}, (_,i) => ({
            x: Math.random()*c.width,
            y: Math.random()*c.height*0.2,
            r: 6+Math.random()*8,
            color: colors[Math.floor(Math.random()*colors.length)],
            vy: 2+Math.random()*3,
            vx: -2+Math.random()*4,
            a: Math.random()*2*Math.PI
        }));
        let frame = 0;
        function draw() {
            ctx.clearRect(0,0,c.width,c.height);
            for (const p of pieces) {
                ctx.save();
                ctx.translate(p.x, p.y);
                ctx.rotate(p.a + frame*0.02);
                ctx.fillStyle = p.color;
                ctx.beginPath();
                ctx.arc(0,0,p.r,0,2*Math.PI);
                ctx.fill();
                ctx.restore();
                p.x += p.vx; p.y += p.vy;
            }
            frame++;
            if (frame < 60) requestAnimationFrame(draw);
            else c.remove();
        }
        draw();
    }
});
