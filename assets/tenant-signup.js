const previewSupportDetails = document.getElementById('previewSupportDetails');
    const previewHost = String(globalThis.location?.hostname || '');
    if(previewSupportDetails){
      previewSupportDetails.hidden = !/^deploy-preview-\d+--euphonious-beijinho-db4b4d\.netlify\.app$/.test(previewHost);
    }

    const form = document.getElementById('signupForm');
    const signupCard = document.getElementById('signupCard');
    const signupButton = document.getElementById('signupButton');
    const signupStatus = document.getElementById('signupStatus');
    const oneTimeKeyPanel = document.getElementById('oneTimeKeyPanel');
    const oneTimeBusinessId = document.getElementById('oneTimeBusinessId');
    const oneTimeKey = document.getElementById('oneTimeKey');
    const planCard = document.getElementById('planCard');
    const checkoutButton = document.getElementById('checkoutButton');
    const manageBillingButton = document.getElementById('manageBillingButton');
    const subscriptionStatus = document.getElementById('subscriptionStatus');
    const accessCard = document.getElementById('accessCard');
    const accessTitle = document.getElementById('accessTitle');
    const accessText = document.getElementById('accessText');
    const founderOffer = document.getElementById('founderOffer');
    const emailPrivacyNote = document.getElementById('emailPrivacyNote');

    function credentials(){
      return {
        businessId: sessionStorage.getItem('growthwise_business_id') || '',
        tenantKey: sessionStorage.getItem('growthwise_tenant_key') || ''
      };
    }

    async function trackMilestone(eventName){
      const { businessId, tenantKey } = credentials();
      if(!businessId || !tenantKey || !eventName) return false;
      const eventDay = new Date().toISOString().slice(0, 10);
      const dedupeKey = `growthwise_onboarding_event:${businessId}:${eventName}:${eventDay}`;
      if(sessionStorage.getItem(dedupeKey) === '1') return true;
      try{
        const response = await fetch('/.netlify/functions/onboarding-event', {
          method: 'POST',
          headers: {
            'Content-Type':'application/json',
            'X-GrowthWise-Tenant-Key': tenantKey
          },
          body: JSON.stringify({ business_id: businessId, event_name: eventName }),
          cache: 'no-store',
          keepalive: true
        });
        const data = await response.json().catch(()=>({}));
        if(!response.ok || data.ok !== true || data.event_name !== eventName) return false;
        sessionStorage.setItem(dedupeKey, '1');
        return true;
      }catch{
        return false;
      }
    }

    function showWorkspace(){
      const { businessId, tenantKey } = credentials();
      if(!businessId || !tenantKey) return false;
      signupCard.classList.add('hidden');
      founderOffer.classList.add('hidden');
      emailPrivacyNote.classList.add('hidden');
      planCard.classList.remove('hidden');
      return true;
    }

    async function refreshStatus(){
      const { businessId, tenantKey } = credentials();
      if(!businessId || !tenantKey) return;
      try{
        const response = await fetch(`/.netlify/functions/subscription-status?business_id=${encodeURIComponent(businessId)}`, {
          headers: { 'X-GrowthWise-Tenant-Key': tenantKey },
          cache: 'no-store'
        });
        const data = await response.json().catch(()=>({}));
        if(!response.ok) throw new Error(data.error || 'Status is temporarily unavailable.');
        const accessGranted = data.access_granted === true
          && (data.access_source === 'stripe' || data.access_source === 'pilot');
        const stripeLinked = data.access_source === 'stripe';
        const pilotAccess = data.access_source === 'pilot';
        if(accessGranted && stripeLinked) await trackMilestone('checkout_completed');
        const labels = { active:'Active', trialing:'Trialing', incomplete:'Checkout pending', past_due:'Payment needs attention', unpaid:'Payment needs attention', paused:'Paused', canceled:'Canceled', not_subscribed:'Not subscribed' };
        subscriptionStatus.textContent = `Current status: ${labels[data.status] || data.status || 'Unknown'} — access ${accessGranted ? 'active' : 'locked'}.`;
        subscriptionStatus.className = `status ${accessGranted ? 'success' : ''}`;
        accessCard.classList.toggle('hidden', !accessGranted);
        planCard.classList.toggle('hidden', pilotAccess);
        if(accessGranted){
          accessTitle.textContent = pilotAccess ? 'Your pilot access is active' : 'Your workspace is ready';
          accessText.textContent = pilotAccess
            ? 'No payment is required during this pilot. Start with a useful Narleo task now.'
            : 'Your subscription is active. Start with a useful Narleo task before connecting anything else.';
        }
        if(accessGranted && (billingResult === 'success' || pilotAccess)){
          accessCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
        manageBillingButton.classList.toggle('hidden', !stripeLinked);
        checkoutButton.disabled = stripeLinked || pilotAccess;
        checkoutButton.textContent = pilotAccess
          ? 'Pilot access active'
          : accessGranted
            ? 'Subscription active'
            : stripeLinked
              ? 'Subscription linked'
              : 'Continue to secure checkout';
      }catch(error){
        subscriptionStatus.textContent = error.message || 'Status is temporarily unavailable.';
        subscriptionStatus.className = 'status error';
        accessCard.classList.add('hidden');
      }
    }

    form.addEventListener('submit', async (event)=>{
      event.preventDefault();
      signupButton.disabled = true;
      signupStatus.className = 'status';
      signupStatus.textContent = 'Creating your private workspace…';
      signupStatus.classList.remove('hidden');
      try{
        const response = await fetch('/.netlify/functions/tenant-signup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            business_name: form.business_name.value,
            business_type: form.business_type.value,
            contact_name: form.contact_name.value,
            email: form.email.value
          })
        });
        const data = await response.json().catch(()=>({}));
        if(!response.ok) throw new Error(data.error || 'Signup is temporarily unavailable.');
        sessionStorage.setItem('growthwise_business_id', data.business_id);
        sessionStorage.setItem('growthwise_tenant_key', data.tenant_key);
        await trackMilestone('workspace_created');
        oneTimeBusinessId.textContent = data.business_id;
        oneTimeKey.textContent = data.tenant_key;
        oneTimeKeyPanel.classList.remove('hidden');
        showWorkspace();
        await refreshStatus();
      }catch(error){
        signupStatus.className = 'status error';
        signupStatus.textContent = error.message || 'Signup is temporarily unavailable.';
      }finally{
        signupButton.disabled = false;
      }
    });

    document.getElementById('copyKeyButton').addEventListener('click', async ()=>{
      await navigator.clipboard.writeText(oneTimeKey.textContent);
      document.getElementById('copyKeyButton').textContent = 'Copied';
    });
    document.getElementById('savedKeyButton').addEventListener('click', ()=>{
      oneTimeBusinessId.textContent = '';
      oneTimeKey.textContent = '';
      oneTimeKeyPanel.classList.add('hidden');
      const target = !accessCard.classList.contains('hidden') ? accessCard : planCard;
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });

    checkoutButton.addEventListener('click', async ()=>{
      const { businessId, tenantKey } = credentials();
      if(!businessId || !tenantKey) return;
      checkoutButton.disabled = true;
      subscriptionStatus.textContent = 'Opening secure checkout…';
      try{
        const response = await fetch('/.netlify/functions/stripe-checkout', {
          method: 'POST',
          headers: { 'Content-Type':'application/json', 'X-GrowthWise-Tenant-Key': tenantKey },
          body: JSON.stringify({ business_id: businessId })
        });
        const data = await response.json().catch(()=>({}));
        if(!response.ok) throw new Error(data.error || 'Checkout is temporarily unavailable.');
        const checkoutUrl = new URL(data.checkout_url);
        if(checkoutUrl.protocol === 'https:' && checkoutUrl.hostname === 'checkout.stripe.com'){
          await trackMilestone('checkout_started');
          window.location.href = checkoutUrl.href;
          return;
        }
        throw new Error('Checkout returned an invalid destination.');
      }catch(error){
        subscriptionStatus.textContent = error.message || 'Checkout is temporarily unavailable.';
        subscriptionStatus.className = 'status error';
        checkoutButton.disabled = false;
      }
    });

    manageBillingButton.addEventListener('click', async ()=>{
      const { businessId, tenantKey } = credentials();
      if(!businessId || !tenantKey) return;
      manageBillingButton.disabled = true;
      subscriptionStatus.textContent = 'Opening secure Stripe billing management…';
      try{
        const response = await fetch('/.netlify/functions/stripe-customer-portal', {
          method: 'POST',
          headers: { 'Content-Type':'application/json', 'X-GrowthWise-Tenant-Key': tenantKey },
          body: JSON.stringify({ business_id: businessId })
        });
        const data = await response.json().catch(()=>({}));
        if(!response.ok) throw new Error(data.error || 'Billing management is temporarily unavailable.');
        const portalUrl = new URL(data.portal_url);
        if(portalUrl.protocol === 'https:' && portalUrl.hostname === 'billing.stripe.com'){
          window.location.href = portalUrl.href;
          return;
        }
        throw new Error('Billing management returned an invalid destination.');
      }catch(error){
        subscriptionStatus.textContent = error.message || 'Billing management is temporarily unavailable.';
        subscriptionStatus.className = 'status error';
        manageBillingButton.disabled = false;
      }
    });

    const billingResult = new URLSearchParams(window.location.search).get('billing');
    if(billingResult === 'success'){
      subscriptionStatus.textContent = 'Checkout finished. Narleo is confirming your access…';
      refreshStatus();
    }else if(billingResult === 'cancelled'){
      subscriptionStatus.textContent = 'Checkout was cancelled. Access remains locked.';
    }else if(billingResult === 'manage-return'){
      subscriptionStatus.textContent = 'Returned from secure billing management. Refreshing status…';
      refreshStatus();
    }
    if(showWorkspace()) refreshStatus();
